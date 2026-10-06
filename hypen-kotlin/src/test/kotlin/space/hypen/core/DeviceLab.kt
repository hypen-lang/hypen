package space.hypen.core

import java.io.File
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import space.hypen.remote.device.*

object DeviceLab {
 @JvmStatic fun main(args: Array<String>) {
  val ui="module App {"+File("../examples/device-lab/app.hypen").readText()+"}"
  val builder=AppBuilder(mutableMapOf<String,Any?>("server" to "Kotlin", "runs" to 0,"result" to "Connected. Choose a check.","detail" to "","history" to "")).ui(ui)
  for(action in listOf("status","query","permission","gallery","file","save","camera","record","scan","bluetooth","cancel","ping")) {
   builder.onActionAsync(action) { ctx ->
    val d=ctx.device
    ctx.state.set("result","$action: running…")
    var text=""
    try {
     text=when(action) {
      "status" -> listOf("gallery.pick","file.pick","file.save","camera.capture","mic.record","bluetooth.scan","bluetooth.select","permission.query","permission.request").joinToString("\n") { "$it: ${d.supports(it)}" }
      "query" -> d.permissions.query(Permission.CAMERA).toString()
      "permission" -> d.permissions.request(Permission.MICROPHONE).toString()
      "save" -> d.files.save("Device Lab payload 0123456789\n".repeat(3400).toByteArray(),"device-lab.txt","text/plain").toString()
      "record" -> { var n=0;val h=d.mic.record(MicRecordParams(16000,MicFormat.PCM16,channels=1,maxDurationMs=3000)){n+=it.size};"${h.await()} bytes=$n" }
      "scan" -> { withTimeout(3000){d.events(Capability.BLUETOOTH_SCAN,BluetoothScanParams).collect { ctx.state.set("detail",it.toString()) }};"scan ended" }
      "ping" -> "UI remains responsive"
      "cancel" -> "Use host Cancel or Stop"
      else -> {
       val (cap,params)=when(action){
        "gallery" -> "gallery.pick" to """{"mediaTypes":["photo"],"maxCount":1}"""
        "file" -> "file.pick" to """{"accept":["text/plain",".txt"],"maxCount":2}"""
        "camera" -> "camera.capture" to """{"mode":"photo","facing":"back"}"""
        else -> "bluetooth.select" to "{}"
       }
       when(val r=d.requestUntyped(cap,Json.parseToJsonElement(params).jsonObject)){
        is DeviceResult.Err -> r.toString()
        is DeviceResult.Ok -> {
         r.value.blobs.forEach { b -> File("../examples/device-lab/results-2026-09-26/uploads").mkdirs();File("../examples/device-lab/results-2026-09-26/uploads/${b.sha256}.bin").writeBytes(b.bytes) }
         "${r.value.result}\nverified blobs: ${r.value.blobs.map{ "${it.bytes.size} bytes ${it.sha256}" }}"
        }
       }
      }
     }
    } catch(e:Exception) {text="${e.javaClass.simpleName}: ${e.message}"}
    ctx.state.set("result","$action: completed")
    ctx.state.set("detail",text)
    println("DEVICE_LAB $action $text")
   }
  }
  val server=HypenServer {module("App",builder.build().copy(name="App"));route("/","App");allowedOrigins("http://127.0.0.1:45100");authenticate {it.path.contains("token=device-lab")}}
  NettyHypenWebSocketServer(server,path="/ws?token=device-lab",listenPort=45103).use { println("Device Lab Kotlin ${it.url}");Thread.currentThread().join() }
 }
}
