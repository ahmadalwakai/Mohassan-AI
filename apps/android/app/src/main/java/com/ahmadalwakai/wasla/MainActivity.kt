package com.ahmadalwakai.wasla

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import com.ahmadalwakai.wasla.ui.MohassanTheme
import com.ahmadalwakai.wasla.ui.RootView

class MainActivity : ComponentActivity() {
    private val store: WaslaStore by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MohassanTheme {
                RootView(store)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        store.sceneChanged(true)
    }

    override fun onStop() {
        super.onStop()
        store.sceneChanged(false)
    }
}
