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
 * جدولة التذكيرات المتكررة - إنشاء سجلات للمعالجة اللاحقة
 */
async function scheduleRecurringReminders(orderId, designerId, notificationId, log, error) {
    try {
        // إنشاء 6 تذكيرات مجدولة (كل 10 دقائق)
        const maxReminders = 6;
        const reminderInterval = 10; // دقائق
        
        for (let i = 1; i <= maxReminders; i++) {
            const reminderTime = new Date(Date.now() + (i * reminderInterval * 60 * 1000));
            
            await databases.createDocument(
                DATABASE_ID,
                'scheduled_reminders',
                'unique()',
                {
                    order_id: orderId,
                    designer_id: designerId,
                    original_notification_id: notificationId,
                    reminder_number: i,
                    scheduled_at: reminderTime.toISOString(),
                    status: 'pending',
                    created_at: new Date().toISOString()
                }
            );
        }
        
        log(`تم جدولة ${maxReminders} تذكيرات للطلب: ${orderId}`);
        
        // تشغيل معالج التذكيرات الفوري للتذكير الأول
        setTimeout(async () => {
            await processScheduledReminders(log, error);
        }, reminderInterval * 60 * 1000);
        
    } catch (err) {
        error(`خطأ في جدولة التذكيرات: ${err.message}`);
        throw err;
    }
}

/**
 * معالجة التذكيرات المجدولة
 */
async function processScheduledReminders(log, error) {
    try {
        const now = new Date().toISOString();
        
        // جلب التذكيرات المستحقة
        const response = await databases.listDocuments(
            DATABASE_ID,
            'scheduled_reminders',
            [
                `status=pending`,
                `scheduled_at<=${now}`
            ]
        );
        
        for (const reminder of response.documents) {
            try {
                // التحقق من حالة القراءة
                const isRead = await checkNotificationReadStatus(
                    reminder.order_id, 
                    reminder.designer_id
                );
                
                if (isRead) {
                    // إلغاء جميع التذكيرات المتبقية لهذا الطلب
                    await cancelRemainingReminders(reminder.order_id, reminder.designer_id);
                    continue;
                }
                
                // إرسال التذكير
                await sendReminderNotification(
                    reminder.order_id,
                    reminder.designer_id,
                    reminder.original_notification_id,
                    reminder.reminder_number,
                    log
                );
                
                // تحديث حالة التذكير
                await databases.updateDocument(
                    DATABASE_ID,
                    'scheduled_reminders',
                    reminder.$id,
                    {
                        status: 'sent',
                        sent_at: new Date().toISOString()
                    }
                );
                
                log(`تم إرسال التذكير رقم ${reminder.reminder_number} للطلب: ${reminder.order_id}`);
                
            } catch (err) {
                error(`خطأ في معالجة التذكير ${reminder.$id}: ${err.message}`);
                
                // تحديث حالة التذكير كفاشل
                await databases.updateDocument(
                    DATABASE_ID,
                    'scheduled_reminders',
                    reminder.$id,
                    {
                        status: 'failed',
                        failed_at: new Date().toISOString(),
                        error_message: err.message
                    }
                );
            }
        }
        
    } catch (err) {
        error(`خطأ في معالجة التذكيرات المجدولة: ${err.message}`);
    }
}

/**
 * إلغاء التذكيرات المتبقية
 */
async function cancelRemainingReminders(orderId, designerId) {
    try {
        const response = await databases.listDocuments(
            DATABASE_ID,
            'scheduled_reminders',
            [
                `order_id=${orderId}`,
                `designer_id=${designerId}`,
                `status=pending`
            ]
        );
        
        for (const reminder of response.documents) {
            await databases.updateDocument(
                DATABASE_ID,
                'scheduled_reminders',
                reminder.$id,
                {
                    status: 'cancelled',
                    cancelled_at: new Date().toISOString(),
                    cancel_reason: 'notification_read'
                }
            );
        }
    } catch (err) {
        console.error('خطأ في إلغاء التذكيرات المتبقية:', err);
    }
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
            data: JSON.stringify({
                order_id: orderId,
                original_notification_id: originalNotificationId,
                type: 'reminder',
                reminder_number: reminderNumber,
                action: 'view_order'
            }),
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
                priority: 'high',
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