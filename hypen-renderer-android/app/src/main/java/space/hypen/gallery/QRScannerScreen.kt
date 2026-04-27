package space.hypen.gallery

import android.Manifest
import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.FlashOff
import androidx.compose.material.icons.filled.FlashOn
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.accompanist.permissions.ExperimentalPermissionsApi
import com.google.accompanist.permissions.isGranted
import com.google.accompanist.permissions.rememberPermissionState
import com.google.accompanist.permissions.shouldShowRationale
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

private const val TAG = "QRScannerScreen"

@OptIn(ExperimentalPermissionsApi::class, ExperimentalMaterial3Api::class)
@Composable
fun QRScannerScreen(
    onQRCodeScanned: (String) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val cameraPermissionState = rememberPermissionState(Manifest.permission.CAMERA)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Scan QR Code") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back"
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                    titleContentColor = Color.White,
                    navigationIconContentColor = Color.White,
                    actionIconContentColor = Color.White,
                )
            )
        },
        containerColor = Color.Black,
        modifier = modifier,
    ) { paddingValues ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
        ) {
            when {
                cameraPermissionState.status.isGranted -> {
                    CameraPreview(
                        onQRCodeScanned = onQRCodeScanned,
                        modifier = Modifier.fillMaxSize()
                    )
                }

                cameraPermissionState.status.shouldShowRationale -> {
                    PermissionRationale(
                        onRequestPermission = { cameraPermissionState.launchPermissionRequest() },
                        modifier = Modifier.fillMaxSize()
                    )
                }

                else -> {
                    PermissionRequest(
                        onRequestPermission = { cameraPermissionState.launchPermissionRequest() },
                        modifier = Modifier.fillMaxSize()
                    )
                }
            }
        }
    }
}

@Composable
private fun CameraPreview(
    onQRCodeScanned: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    var flashEnabled by remember { mutableStateOf(false) }
    var camera by remember { mutableStateOf<androidx.camera.core.Camera?>(null) }
    var hasScanned by remember { mutableStateOf(false) }
    val previewView = remember { PreviewView(context) }

    // Setup camera using callback
    DisposableEffect(lifecycleOwner) {
        val cameraProviderFuture = ProcessCameraProvider.getInstance(context)

        cameraProviderFuture.addListener({
            try {
                val cameraProvider = cameraProviderFuture.get()

                val preview = Preview.Builder().build().also {
                    it.surfaceProvider = previewView.surfaceProvider
                }

                val imageAnalysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                    .also { analysis ->
                        analysis.setAnalyzer(
                            Executors.newSingleThreadExecutor(),
                            QRCodeAnalyzer { qrCode ->
                                if (!hasScanned) {
                                    hasScanned = true
                                    onQRCodeScanned(qrCode)
                                }
                            }
                        )
                    }

                val cameraSelector = CameraSelector.DEFAULT_BACK_CAMERA

                cameraProvider.unbindAll()
                camera = cameraProvider.bindToLifecycle(
                    lifecycleOwner,
                    cameraSelector,
                    preview,
                    imageAnalysis
                )
            } catch (e: Exception) {
                Log.e(TAG, "Camera binding failed", e)
            }
        }, ContextCompat.getMainExecutor(context))

        onDispose {
            // Camera will be unbound when lifecycle owner is destroyed
        }
    }

    Box(modifier = modifier) {
        AndroidView(
            factory = { previewView },
            modifier = Modifier.fillMaxSize()
        )

        // Scanning overlay
        ScannerOverlay(
            modifier = Modifier.fillMaxSize()
        )

        // Flash toggle button
        camera?.let { cam ->
            if (cam.cameraInfo.hasFlashUnit()) {
                IconButton(
                    onClick = {
                        flashEnabled = !flashEnabled
                        cam.cameraControl.enableTorch(flashEnabled)
                    },
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .padding(bottom = 32.dp)
                        .background(
                            color = Color.Black.copy(alpha = 0.5f),
                            shape = RoundedCornerShape(50)
                        )
                ) {
                    Icon(
                        imageVector = if (flashEnabled) Icons.Default.FlashOn else Icons.Default.FlashOff,
                        contentDescription = if (flashEnabled) "Turn flash off" else "Turn flash on",
                        tint = Color.White,
                    )
                }
            }
        }

        // Instructions
        Text(
            text = "Point camera at a QR code",
            style = MaterialTheme.typography.bodyLarge,
            color = Color.White,
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 100.dp)
                .background(
                    color = Color.Black.copy(alpha = 0.5f),
                    shape = RoundedCornerShape(8.dp)
                )
                .padding(horizontal = 16.dp, vertical = 8.dp)
        )
    }
}

@Composable
private fun ScannerOverlay(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier,
        contentAlignment = Alignment.Center
    ) {
        // Scanning frame with corner indicators
        Box(
            modifier = Modifier.size(280.dp)
        ) {
            // Corner indicators using borders
            val cornerSize = 40.dp
            val cornerWidth = 4.dp
            val cornerColor = Color.White

            // Top-left corner
            Box(
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .size(cornerSize)
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(cornerWidth)
                        .background(cornerColor)
                )
                Box(
                    modifier = Modifier
                        .fillMaxHeight()
                        .width(cornerWidth)
                        .background(cornerColor)
                )
            }

            // Top-right corner
            Box(
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .size(cornerSize)
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(cornerWidth)
                        .background(cornerColor)
                )
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .fillMaxHeight()
                        .width(cornerWidth)
                        .background(cornerColor)
                )
            }

            // Bottom-left corner
            Box(
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .size(cornerSize)
            ) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .fillMaxWidth()
                        .height(cornerWidth)
                        .background(cornerColor)
                )
                Box(
                    modifier = Modifier
                        .fillMaxHeight()
                        .width(cornerWidth)
                        .background(cornerColor)
                )
            }

            // Bottom-right corner
            Box(
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .size(cornerSize)
            ) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .fillMaxWidth()
                        .height(cornerWidth)
                        .background(cornerColor)
                )
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .fillMaxHeight()
                        .width(cornerWidth)
                        .background(cornerColor)
                )
            }
        }
    }
}

@Composable
private fun PermissionRequest(
    onRequestPermission: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = "Camera Permission Required",
            style = MaterialTheme.typography.headlineSmall,
            color = Color.White,
        )

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = "To scan QR codes, we need access to your camera.",
            style = MaterialTheme.typography.bodyMedium,
            color = Color.White.copy(alpha = 0.7f),
        )

        Spacer(modifier = Modifier.height(24.dp))

        Button(onClick = onRequestPermission) {
            Text("Grant Permission")
        }
    }
}

@Composable
private fun PermissionRationale(
    onRequestPermission: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier.padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = "Camera Permission Needed",
            style = MaterialTheme.typography.headlineSmall,
            color = Color.White,
        )

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = "The camera permission is needed to scan QR codes that contain Hypen app URLs. Your camera is only used for scanning and no images are stored.",
            style = MaterialTheme.typography.bodyMedium,
            color = Color.White.copy(alpha = 0.7f),
        )

        Spacer(modifier = Modifier.height(24.dp))

        Button(onClick = onRequestPermission) {
            Text("Grant Permission")
        }
    }
}

private class QRCodeAnalyzer(
    private val onQRCodeDetected: (String) -> Unit,
) : ImageAnalysis.Analyzer {

    private val scanner = BarcodeScanning.getClient()

    @androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
    override fun analyze(imageProxy: ImageProxy) {
        val mediaImage = imageProxy.image
        if (mediaImage != null) {
            val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)

            scanner.process(image)
                .addOnSuccessListener { barcodes ->
                    for (barcode in barcodes) {
                        if (barcode.valueType == Barcode.TYPE_URL ||
                            barcode.valueType == Barcode.TYPE_TEXT
                        ) {
                            val value = barcode.url?.url ?: barcode.rawValue
                            if (value != null && isValidHypenUrl(value)) {
                                onQRCodeDetected(value)
                                return@addOnSuccessListener
                            }
                        }
                    }
                }
                .addOnCompleteListener {
                    imageProxy.close()
                }
        } else {
            imageProxy.close()
        }
    }

    private fun isValidHypenUrl(url: String): Boolean {
        // Accept WebSocket URLs (ws:// or wss://) or HTTP URLs
        return url.startsWith("ws://") ||
                url.startsWith("wss://") ||
                url.startsWith("http://") ||
                url.startsWith("https://")
    }
}
