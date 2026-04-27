package space.hypen.gallery

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.FullscreenExit
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusProperties
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun BrowserToolbar(
    currentUrl: String,
    isConnected: Boolean,
    isLoading: Boolean,
    canGoBack: Boolean,
    isFullscreen: Boolean,
    onUrlSubmit: (String) -> Unit,
    onBackClick: () -> Unit,
    onHomeClick: () -> Unit,
    onRefreshClick: () -> Unit,
    onScanQrClick: () -> Unit,
    onFullscreenToggle: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // Use TextFieldValue so the cursor/selection state is stable across recompositions.
    // Do NOT key this on `currentUrl` — that would clobber user input while typing.
    var fieldValue by remember { mutableStateOf(TextFieldValue(currentUrl)) }
    var isEditing by remember { mutableStateOf(false) }
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    val focusRequester = remember { FocusRequester() }

    // Sync external URL changes into the field only when the user isn't actively editing,
    // so navigation/refresh updates are reflected without interrupting typing.
    LaunchedEffect(currentUrl, isEditing) {
        if (!isEditing && fieldValue.text != currentUrl) {
            fieldValue = TextFieldValue(
                text = currentUrl,
                selection = TextRange(currentUrl.length),
            )
        }
    }

    fun startEditing() {
        // Pre-select existing URL so typing instantly replaces it (standard browser UX).
        fieldValue = TextFieldValue(
            text = currentUrl,
            selection = TextRange(0, currentUrl.length),
        )
        isEditing = true
    }

    fun finishEditing(submit: Boolean) {
        val trimmed = fieldValue.text.trim()
        isEditing = false
        keyboardController?.hide()
        focusManager.clearFocus()
        if (submit && trimmed.isNotEmpty()) {
            onUrlSubmit(trimmed)
        } else {
            // Reset to the current (authoritative) URL.
            fieldValue = TextFieldValue(
                text = currentUrl,
                selection = TextRange(currentUrl.length),
            )
        }
    }

    Surface(
        modifier = modifier.fillMaxWidth(),
        shadowElevation = 4.dp,
        color = MaterialTheme.colorScheme.surface,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            // Back button
            IconButton(
                onClick = onBackClick,
                enabled = canGoBack,
            ) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "Back",
                    tint = if (canGoBack) {
                        MaterialTheme.colorScheme.onSurface
                    } else {
                        MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
                    }
                )
            }

            // Home button
            IconButton(onClick = onHomeClick) {
                Icon(
                    imageVector = Icons.Default.Home,
                    contentDescription = "Home",
                )
            }

            // Refresh button
            IconButton(
                onClick = onRefreshClick,
                enabled = isConnected,
            ) {
                if (isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                    )
                } else {
                    Icon(
                        imageVector = Icons.Default.Refresh,
                        contentDescription = "Refresh",
                        tint = if (isConnected) {
                            MaterialTheme.colorScheme.onSurface
                        } else {
                            MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
                        }
                    )
                }
            }

            // URL Bar
            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(40.dp)
                    .clip(RoundedCornerShape(20.dp))
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .clickable(enabled = !isEditing) { startEditing() }
                    .padding(horizontal = 16.dp),
                contentAlignment = Alignment.CenterStart,
            ) {
                if (isEditing) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        BasicTextField(
                            value = fieldValue,
                            onValueChange = { fieldValue = it },
                            singleLine = true,
                            textStyle = TextStyle(
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                fontSize = 14.sp,
                            ),
                            cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                            keyboardOptions = KeyboardOptions(
                                keyboardType = KeyboardType.Uri,
                                imeAction = ImeAction.Go,
                                autoCorrect = false,
                            ),
                            keyboardActions = KeyboardActions(
                                onGo = { finishEditing(submit = true) }
                            ),
                            modifier = Modifier
                                .weight(1f)
                                .focusRequester(focusRequester)
                                .onFocusChanged { state ->
                                    // Exit editing only when focus is lost AFTER we've gained it.
                                    // We don't reset `fieldValue` here — keeping the user's text
                                    // avoids clobbering input during transient focus events.
                                    if (!state.isFocused && isEditing) {
                                        isEditing = false
                                    }
                                },
                            decorationBox = { innerTextField ->
                                Box(
                                    modifier = Modifier.fillMaxWidth(),
                                    contentAlignment = Alignment.CenterStart,
                                ) {
                                    if (fieldValue.text.isEmpty()) {
                                        Text(
                                            text = "Enter URL or scan QR",
                                            style = TextStyle(
                                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f),
                                                fontSize = 14.sp,
                                            ),
                                        )
                                    }
                                    innerTextField()
                                }
                            }
                        )

                        // Inline clear button — handy for quickly replacing URL.
                        // `focusProperties { canFocus = false }` prevents the clickable from
                        // stealing focus from the TextField (which would exit edit mode).
                        if (fieldValue.text.isNotEmpty()) {
                            Box(
                                modifier = Modifier
                                    .size(20.dp)
                                    .clip(RoundedCornerShape(10.dp))
                                    .focusProperties { canFocus = false }
                                    .clickable {
                                        fieldValue = TextFieldValue("")
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Clear,
                                    contentDescription = "Clear URL",
                                    tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                                    modifier = Modifier.size(16.dp),
                                )
                            }
                        }
                    }

                    // Request focus exactly once per editing session.
                    LaunchedEffect(isEditing) {
                        if (isEditing) {
                            focusRequester.requestFocus()
                        }
                    }
                } else {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        // Connection indicator
                        if (isConnected) {
                            Box(
                                modifier = Modifier
                                    .size(8.dp)
                                    .clip(RoundedCornerShape(4.dp))
                                    .background(MaterialTheme.colorScheme.primary)
                            )
                            Spacer(modifier = Modifier.width(8.dp))
                        }

                        Text(
                            text = currentUrl.ifEmpty { "Enter URL or scan QR" },
                            style = TextStyle(
                                color = if (currentUrl.isEmpty()) {
                                    MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
                                } else {
                                    MaterialTheme.colorScheme.onSurfaceVariant
                                },
                                fontSize = 14.sp,
                            ),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }

            // QR Scanner button
            IconButton(onClick = onScanQrClick) {
                Icon(
                    imageVector = Icons.Outlined.QrCodeScanner,
                    contentDescription = "Scan QR Code",
                )
            }

            // Fullscreen toggle
            IconButton(onClick = onFullscreenToggle) {
                Icon(
                    imageVector = if (isFullscreen) {
                        Icons.Default.FullscreenExit
                    } else {
                        Icons.Default.Fullscreen
                    },
                    contentDescription = if (isFullscreen) "Exit fullscreen" else "Enter fullscreen",
                )
            }
        }
    }
}
