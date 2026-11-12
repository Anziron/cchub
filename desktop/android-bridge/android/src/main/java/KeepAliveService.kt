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
import android.net.LocalServerSocket
import android.util.Log
import java.io.IOException
import kotlin.concurrent.thread
import org.json.JSONObject

/**
 * 只负责让进程留在前台优先级，WebSocket 在 Rust 里。
 * 进程被系统杀掉后不自动拉起：拉起的进程里没有 Rust 连接，常驻通知会误导用户。
 */
class KeepAliveService : Service() {
    private var server: LocalServerSocket? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val socket = LocalServerSocket(SOCKET_NAME)
        server = socket
        thread(name = "cchub-bridge", isDaemon = true) { serve(socket) }
    }

    override fun onDestroy() {
        server?.close()
        server = null
        super.onDestroy()
    }

    /**
     * 通知和状态由 Rust 经本地 socket 发来。不能走 Tauri 插件：
     * 划掉任务后 Activity 没了，插件调用会让进程 panic，而这时正需要通知。
     */
    private fun serve(socket: LocalServerSocket) {
        while (true) {
            val client = try {
                socket.accept()
            } catch (_: IOException) {
                return
            }
            try {
                client.use {
                    // 抽象地址谁都能连，只接受自己。
                    if (it.peerCredentials.uid != Process.myUid()) return@use
                    val line = it.inputStream.bufferedReader().readLine() ?: return@use
                    handle(JSONObject(line))
                }
            } catch (error: Exception) {
                Log.w(TAG, "bad message", error)
            }
        }
    }

    private fun handle(message: JSONObject) {
        val manager = getSystemService(NotificationManager::class.java)
        when (message.getString("cmd")) {
            "status" -> synchronized(statusLock) {
                lastStatus = message.getString("text")
                manager.notify(STATUS_ID, build(this, lastStatus))
            }
            "notify" -> {
                Log.i(TAG, "notify foreground=$inForeground")
                // 前台时界面上已经能看到，不再打扰。
                if (inForeground) return
                val session = message.getString("session")
                val id = NOTIFY_BASE + (session.hashCode() and 0xFFFF)
                val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    Notification.Builder(this, ASK_CHANNEL)
                } else {
                    @Suppress("DEPRECATION")
                    Notification.Builder(this).setPriority(Notification.PRIORITY_HIGH)
                }
                manager.notify(
                    id,
                    builder
                        .setSmallIcon(R.drawable.ic_cchub_status)
                        .setContentTitle("CcHub")
                        .setContentText(message.getString("body"))
                        .setAutoCancel(true)
                        .setContentIntent(openApp(this, session, id))
                        .build(),
                )
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_EXIT) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            Process.killProcess(Process.myPid())
            return START_NOT_STICKY
        }
        // 服务启动是异步的，这时状态可能已经更新过，所以读最新值。
        // 读值、构建、发出要和 status 消息互斥：否则这里读到旧状态，构建期间新状态先发出去，
        // startForeground 再用旧文字盖掉它，通知就一直停在“正在连接服务器”。
        synchronized(statusLock) {
            val notification = build(this, lastStatus)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(STATUS_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(STATUS_ID, notification)
            }
        }
        return START_NOT_STICKY
    }

    companion object {
        const val STATUS_ID = 1
        private const val NOTIFY_BASE = 0x10000
        private const val TAG = "cchub-bridge"
        /** 和 `desktop/src/mobile.rs` 里的一致。 */
        private const val SOCKET_NAME = "dev.anziron.cchub.bridge"

        @Volatile
        var inForeground = false

        const val STATUS_CHANNEL = "cchub-status"
        const val ASK_CHANNEL = "cchub-ask"
        const val ACTION_EXIT = "dev.anziron.cchub.EXIT"

        @Volatile
        var lastStatus = "正在连接服务器"

        /** 保护“改 lastStatus 并发出状态通知”这一步，见 onStartCommand。 */
        private val statusLock = Any()

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
                .setContentTitle("CcHub")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setContentIntent(openApp(context, null, 0))
                .addAction(Notification.Action.Builder(null, "退出", exit).build())
                .build()
        }
    }
}
