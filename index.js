const { Client, Databases, Functions } = require('node-appwrite');

// إعداد Appwrite
const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT)
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);
const functions = new Functions(client);

const DATABASE_ID = 'abs-rtk-db';
const REMINDER_SCHEDULE_COLLECTION = 'reminder_schedule';
const ORDER_NOTIFICATIONS_COLLECTION = 'order_notifications';

/**
 * Cloud Function لجدولة وإرسال تذكيرات الطلبات للمصممات
 */
module.exports = async ({ req, res, log, error }) => {
    try {
        const { order_id, designer_id, notification_id } = JSON.parse(req.body);
        
        log(`بدء معالجة التذكيرات للطلب: ${order_id}, المصممة: ${designer_id}`);

        // جدولة التذكيرات المتكررة
        await scheduleRecurringReminders(order_id, designer_id, notification_id, log, error);

        return res.json({
            success: true,
            message: 'تم جدولة التذكيرات بنجاح'
        });

    } catch (err) {
        error(`خطأ في Cloud Function: ${err.message}`);
        return res.json({
            success: false,
            error: err.message
        }, 500);
    }
};

/**
 * جدولة التذكيرات المتكررة كل 5 دقائق
 */
async function scheduleRecurringReminders(orderId, designerId, notificationId, log, error) {
    const maxReminders = 6; // حد أقصى 6 تذكيرات (ساعة واحدة)
    let reminderCount = 0;

    const reminderInterval = setInterval(async () => {
        try {
            // التحقق من حالة القراءة
            const isRead = await checkNotificationReadStatus(orderId, designerId);
            
            if (isRead) {
                log(`تم قراءة الإشعار، إيقاف التذكيرات للطلب: ${orderId}`);
                clearInterval(reminderInterval);
                await deactivateReminderSchedule(orderId, designerId, 'notification_read');
                return;
            }

            // التحقق من الحد الأقصى للتذكيرات
            if (reminderCount >= maxReminders) {
                log(`تم الوصول للحد الأقصى من التذكيرات للطلب: ${orderId}`);
                clearInterval(reminderInterval);
                await deactivateReminderSchedule(orderId, designerId, 'max_reminders_reached');
                return;
            }

            // إرسال التذكير
            await sendReminderNotification(orderId, designerId, notificationId, reminderCount + 1, log);
            reminderCount++;

            log(`تم إرسال التذكير رقم ${reminderCount} للطلب: ${orderId}`);

        } catch (err) {
            error(`خطأ في إرسال التذكير: ${err.message}`);
            clearInterval(reminderInterval);
        }
    }, 5 * 60 * 1000); // 1 دقائق

    // إيقاف التذكيرات بعد ساعة واحدة كحد أقصى
    setTimeout(() => {
        clearInterval(reminderInterval);
        deactivateReminderSchedule(orderId, designerId, 'timeout');
    }, 60 * 60 * 1000); // ساعة واحدة
}

/**
 * التحقق من حالة قراءة الإشعار
 */
async function checkNotificationReadStatus(orderId, designerId) {
    try {
        const response = await databases.listDocuments(
            DATABASE_ID,
            ORDER_NOTIFICATIONS_COLLECTION,
            [
                `order_id=${orderId}`,
                `designer_id=${designerId}`
            ]
        );

        if (response.documents.length > 0) {
            return response.documents[0].is_read || false;
        }
        return false;
    } catch (err) {
        console.error('خطأ في التحقق من حالة القراءة:', err);
        return false;
    }
}

/**
 * إرسال إشعار تذكير
 */
async function sendReminderNotification(orderId, designerId, originalNotificationId, reminderNumber, log) {
    try {
        // إنشاء إشعار التذكير
        const reminderNotification = {
            title: `تذكير ${reminderNumber}: طلب جديد #${orderId.substring(0, 8)}`,
            message: `لم تقم بقراءة إشعار الطلب الجديد بعد. يرجى مراجعة الطلب.`,
            type: 'order_reminder',
            target_audience: `designer:${designerId}`,
            is_in_app: true,
            is_push: true,
            data: {
                order_id: orderId,
                original_notification_id: originalNotificationId,
                type: 'reminder',
                reminder_number: reminderNumber,
                action: 'view_order'
            },
            scheduled_at: new Date().toISOString(),
            status: 'sent',
            created_at: new Date().toISOString()
        };

        // حفظ الإشعار في قاعدة البيانات
        await databases.createDocument(
            DATABASE_ID,
            'notifications',
            'unique()',
            reminderNotification
        );

        // إضافة إلى قائمة انتظار الإشعارات للإرسال الفوري
        await databases.createDocument(
            DATABASE_ID,
            'notification_queue',
            'unique()',
            {
                title: reminderNotification.title,
                message: reminderNotification.message,
                target_audience: reminderNotification.target_audience,
                data: reminderNotification.data,
                status: 'pending',
                created_at: new Date().toISOString()
            }
        );

        log(`تم إنشاء إشعار التذكير رقم ${reminderNumber} للطلب: ${orderId}`);

    } catch (err) {
        console.error('خطأ في إرسال إشعار التذكير:', err);
        throw err;
    }
}

/**
 * إلغاء تفعيل جدولة التذكيرات
 */
async function deactivateReminderSchedule(orderId, designerId, reason) {
    try {
        const response = await databases.listDocuments(
            DATABASE_ID,
            REMINDER_SCHEDULE_COLLECTION,
            [
                `order_id=${orderId}`,
                `designer_id=${designerId}`,
                `is_active=true`
            ]
        );

        for (const doc of response.documents) {
            await databases.updateDocument(
                DATABASE_ID,
                REMINDER_SCHEDULE_COLLECTION,
                doc.$id,
                {
                    is_active: false,
                    stopped_reason: reason,
                    stopped_at: new Date().toISOString()
                }
            );
        }
    } catch (err) {
        console.error('خطأ في إلغاء تفعيل جدولة التذكيرات:', err);
    }
}
