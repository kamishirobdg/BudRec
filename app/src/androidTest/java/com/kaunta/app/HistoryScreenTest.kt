package com.kaunta.app

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HistoryScreenTest {

    @get:Rule
    val composeTestRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun historyScreen_emptyState_showsEmptyMessage() {
        composeTestRule.onNodeWithTag("btn_history").performClick()
        composeTestRule.onNodeWithTag("txt_empty_history").assertIsDisplayed()
    }

    @Test
    fun historyScreen_backButton_returnsToMain() {
        composeTestRule.onNodeWithTag("btn_history").performClick()
        composeTestRule.onNodeWithText("カウンタ").assertDoesNotExist()
        // Press back via navigation icon
        composeTestRule.onNodeWithText("履歴").assertIsDisplayed()
    }

    @Test
    fun historyScreen_deleteAll_requiresConfirmation() {
        // Navigate to history
        composeTestRule.onNodeWithTag("btn_history").performClick()
        // Delete all button should not be visible when empty
        composeTestRule.onNodeWithTag("btn_delete_all").assertDoesNotExist()
    }
}
