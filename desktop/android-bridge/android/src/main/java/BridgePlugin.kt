package dev.anziron.cchub.bridge

import android.Manifest
import android.app.Activity
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

@InvokeArg
class StatusArgs {
    var text: String = ""
}

@InvokeArg
class NotifyArgs {
    var session: String = ""
    var body: String = ""
}

@TauriPlugin
class BridgePlugin(private val activity: Activity) : Plugin(activity) {
    private val app: Context = activity.applicationContext
    private var webView: WebView? = null

    override fun load(webView: WebView) {
        super.load(webView)
        this.webView = webView
        KeepAliveService.createChannels(app)
        pendingSession = activity.intent?.getStringExtra(EXTRA_SESSION) ?: pendingSession
        activity.intent?.removeExtra(EXTRA_SESSION)
        restartWhenRecreated()
        fitSystemBars()
        handleBack(webView)
    }

    /**
     * 划掉任务后进程还在维持连接，但 Tauri 不能在同一进程里重建界面，直接显示会是白屏。
     * 所以新的 Activity 一出现就换一个干净的进程；连接会自动恢复，通知水位在磁盘上，不会重复提醒。
     */
    private fun restartWhenRecreated() {
        val mainClass = activity.javaClass
        activity.application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            override fun onActivityCreated(created: Activity, state: Bundle?) {
                if (created.javaClass != mainClass || created === activity) return
                Log.i(TAG, "activity recreated, restarting process")
                created.startActivity(
                    Intent(created, RestartActivity::class.java)
                        .putExtra(EXTRA_SESSION, created.intent?.getStringExtra(EXTRA_SESSION)),
                )
                Process.killProcess(Process.myPid())
            }

            override fun onActivityStarted(a: Activity) {}
            override fun onActivityResumed(a: Activity) {}
            override fun onActivityPaused(a: Activity) {}
            override fun onActivityStopped(a: Activity) {}
            override fun onActivitySaveInstanceState(a: Activity, state: Bundle) {}
            override fun onActivityDestroyed(a: Activity) {}
        })
    }

    /** targetSdk 35 起内容默认铺到系统栏和键盘下面，这里统一留出空间。 */
    private fun fitSystemBars() {
        // 监听装在 decorView 上：content 视图收到系统栏信息之前可能已被 AppCompat 的外层消费。
        val decor = activity.window.decorView
        val content = activity.findViewById<android.view.View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(decor) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            content.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            ViewCompat.onApplyWindowInsets(view, insets)
        }
        ViewCompat.requestApplyInsets(decor)
    }

    /** 界面先处理（关弹窗、回列表），没有可退的就退到后台，不销毁 Activity。 */
    private fun handleBack(webView: WebView) {
        val owner = activity as? ComponentActivity ?: return
        owner.onBackPressedDispatcher.addCallback(owner, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                webView.evaluateJavascript("window.__cchubBack?.() === true") { handled ->
                    if (handled != "true") activity.moveTaskToBack(true)
                }
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        val session = intent.getStringExtra(EXTRA_SESSION) ?: return
        intent.removeExtra(EXTRA_SESSION)
        // 界面已加载时直接跳转；还没加载完就留给启动时取。
        val quoted = JSONObject.quote(session)
        val view = webView
        if (view == null) {
            pendingSession = session
            return
        }
        view.evaluateJavascript("window.__cchubOpen?.($quoted) === true") { handled ->
            if (handled != "true") pendingSession = session
        }
    }

    override fun onResume(activity: AppCompatActivity) {
        inForeground = true
    }

    override fun onPause(activity: AppCompatActivity) {
        inForeground = false
    }

    @Command
    fun startService(invoke: Invoke) {
        Log.i(TAG, "startService")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), PERMISSION_REQUEST)
        }
        val intent = Intent(app, KeepAliveService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            app.startForegroundService(intent)
        } else {
            app.startService(intent)
        }
        invoke.resolve()
    }

    @Command
    fun setStatus(invoke: Invoke) {
        Log.i(TAG, "setStatus")
        val args = invoke.parseArgs(StatusArgs::class.java)
        KeepAliveService.lastStatus = args.text
        manager().notify(KeepAliveService.STATUS_ID, KeepAliveService.build(app, args.text))
        invoke.resolve()
    }

    @Command
    fun notify(invoke: Invoke) {
        Log.i(TAG, "notify foreground=$inForeground")
        val args = invoke.parseArgs(NotifyArgs::class.java)
        // 前台时界面上已经能看到，不再打扰。
        if (!inForeground) {
            val id = NOTIFY_BASE + (args.session.hashCode() and 0xFFFF)
            val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(app, KeepAliveService.ASK_CHANNEL)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(app).setPriority(Notification.PRIORITY_HIGH)
            }
            val notification = builder
                .setSmallIcon(R.drawable.ic_cchub_status)
                .setContentTitle("cchub")
                .setContentText(args.body)
                .setAutoCancel(true)
                .setContentIntent(KeepAliveService.openApp(app, args.session, id))
                .build()
            manager().notify(id, notification)
        }
        invoke.resolve()
    }

    @Command
    fun takeOpenedSession(invoke: Invoke) {
        val result = JSObject()
        result.put("session", pendingSession ?: JSONObject.NULL)
        pendingSession = null
        invoke.resolve(result)
    }

    @Command
    fun background(invoke: Invoke) {
        val power = app.getSystemService(PowerManager::class.java)
        val result = JSObject()
        result.put("notificationsAllowed", manager().areNotificationsEnabled())
        result.put("batteryUnrestricted", power.isIgnoringBatteryOptimizations(app.packageName))
        invoke.resolve(result)
    }

    @Command
    fun requestBatteryUnrestricted(invoke: Invoke) {
        activity.startActivity(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(Uri.parse("package:${app.packageName}")),
        )
        invoke.resolve()
    }

    private fun manager() = app.getSystemService(NotificationManager::class.java)

    companion object {
        const val EXTRA_SESSION = "dev.anziron.cchub.SESSION"
        private const val TAG = "cchub-bridge"
        private const val PERMISSION_REQUEST = 4101
        private const val NOTIFY_BASE = 0x10000

        @Volatile
        private var inForeground = false

        @Volatile
        private var pendingSession: String? = null
    }
}
