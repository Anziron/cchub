package dev.anziron.cchub.bridge

import android.app.Activity
import android.os.Bundle
import android.os.Process

/** 在单独的进程里运行，只负责重新打开界面，然后自己结束。 */
class RestartActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val launch = packageManager.getLaunchIntentForPackage(packageName)!!
        intent.getStringExtra(BridgePlugin.EXTRA_SESSION)?.let { launch.putExtra(BridgePlugin.EXTRA_SESSION, it) }
        startActivity(launch)
        finish()
        Process.killProcess(Process.myPid())
    }
}
