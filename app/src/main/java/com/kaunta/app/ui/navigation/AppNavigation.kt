package com.kaunta.app.ui.navigation

import androidx.compose.runtime.Composable
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import com.kaunta.app.ui.history.HistoryScreen
import com.kaunta.app.ui.main.MainScreen
import com.kaunta.app.ui.settings.SettingsScreen

sealed class Screen(val route: String) {
    object Main : Screen("main")
    object Settings : Screen("settings")
    object History : Screen("history")
}

@Composable
fun AppNavigation(navController: NavHostController) {
    NavHost(navController = navController, startDestination = Screen.Main.route) {
        composable(Screen.Main.route) {
            MainScreen(
                onNavigateToSettings = { navController.navigate(Screen.Settings.route) },
                onNavigateToHistory = { navController.navigate(Screen.History.route) }
            )
        }
        composable(Screen.Settings.route) {
            SettingsScreen(
                onNavigateBack = { navController.popBackStack() }
            )
        }
        composable(Screen.History.route) {
            HistoryScreen(
                onNavigateBack = { navController.popBackStack() }
            )
        }
    }
}
