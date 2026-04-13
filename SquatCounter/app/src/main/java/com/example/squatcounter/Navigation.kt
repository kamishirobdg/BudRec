package com.example.squatcounter

import androidx.compose.runtime.Composable
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.example.squatcounter.ui.history.HistoryDetailScreen
import com.example.squatcounter.ui.history.HistoryScreen
import com.example.squatcounter.ui.main.MainScreen
import com.example.squatcounter.ui.settings.SettingsScreen

@Composable
fun AppNavigation() {
    val nav = rememberNavController()

    NavHost(navController = nav, startDestination = "main") {
        composable("main") {
            MainScreen(
                onNavigateToHistory = { nav.navigate("history") },
                onNavigateToSettings = { nav.navigate("settings") }
            )
        }
        composable("settings") {
            SettingsScreen(onBack = { nav.popBackStack() })
        }
        composable("history") {
            HistoryScreen(
                onBack = { nav.popBackStack() },
                onGroupClick = { year, month, week ->
                    nav.navigate("history_detail/$year/$month/$week")
                }
            )
        }
        composable(
            "history_detail/{year}/{month}/{week}",
            arguments = listOf(
                navArgument("year") { type = NavType.IntType },
                navArgument("month") { type = NavType.IntType },
                navArgument("week") { type = NavType.IntType }
            )
        ) { back ->
            val year = back.arguments!!.getInt("year")
            val month = back.arguments!!.getInt("month")
            val week = back.arguments!!.getInt("week")
            HistoryDetailScreen(
                year = year, month = month, week = week,
                onBack = { nav.popBackStack() }
            )
        }
    }
}
