package dev.anziron.cchub.bridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Process

/**
 * 只负责让进程留在前台优先级，WebSocket 在 Rust 里。
 * 进程被系统杀掉后不自动拉起：拉起的进程里没有 Rust 连接，常驻通知会误导用户。
 */
class KeepAliveService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_EXIT) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            Process.killProcess(Process.myPid())
            return START_NOT_STICKY
        }
        val notification = build(this, intent?.getStringExtra(EXTRA_TEXT) ?: lastStatus)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(STATUS_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(STATUS_ID, notification)
        }
        return START_NOT_STICKY
    }

    companion object {
        const val STATUS_ID = 1
        const val STATUS_CHANNEL = "cchub-status"
        const val ASK_CHANNEL = "cchub-ask"
        const val EXTRA_TEXT = "text"
        const val ACTION_EXIT = "dev.anziron.cchub.EXIT"

        var lastStatus = "正在连接服务器"

        fun createChannels(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(STATUS_CHANNEL, "连接状态", NotificationManager.IMPORTANCE_LOW),
            )
            manager.createNotificationChannel(
                NotificationChannel(ASK_CHANNEL, "等你决定", NotificationManager.IMPORTANCE_HIGH),
            )
        }

        fun openApp(context: Context, session: String?, requestCode: Int): PendingIntent {
            val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)!!
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            if (session != null) intent.putExtra(BridgePlugin.EXTRA_SESSION, session)
            return PendingIntent.getActivity(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }

        fun build(context: Context, text: String): Notification {
            val exit = PendingIntent.getService(
                context,
                0,
                Intent(context, KeepAliveService::class.java).setAction(ACTION_EXIT),
                PendingIntent.FLAG_IMMUTABLE,
            )
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(context, STATUS_CHANNEL)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(context)
            }
            return builder
                .setSmallIcon(R.drawable.ic_cchub_status)
                .setContentTitle("cchub")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(openApp(context, null, 0))
                .addAction(Notification.Action.Builder(null, "退出", exit).build())
                .build()
        }
    }
}
