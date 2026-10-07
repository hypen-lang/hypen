package space.hypen.core

import io.netty.bootstrap.ServerBootstrap
import io.netty.buffer.ByteBufUtil
import io.netty.buffer.Unpooled
import io.netty.channel.Channel
import io.netty.channel.ChannelFuture
import io.netty.channel.ChannelFutureListener
import io.netty.channel.ChannelHandlerContext
import io.netty.channel.ChannelInitializer
import io.netty.channel.SimpleChannelInboundHandler
import io.netty.channel.nio.NioEventLoopGroup
import io.netty.channel.socket.SocketChannel
import io.netty.channel.socket.nio.NioServerSocketChannel
import io.netty.handler.codec.http.DefaultFullHttpResponse
import io.netty.handler.codec.http.FullHttpRequest
import io.netty.handler.codec.http.HttpHeaderNames
import io.netty.handler.codec.http.HttpObjectAggregator
import io.netty.handler.codec.http.HttpResponseStatus
import io.netty.handler.codec.http.HttpServerCodec
import io.netty.handler.codec.http.HttpVersion
import io.netty.handler.codec.http.websocketx.BinaryWebSocketFrame
import io.netty.handler.codec.http.websocketx.CloseWebSocketFrame
import io.netty.handler.codec.http.websocketx.TextWebSocketFrame
import io.netty.handler.codec.http.websocketx.WebSocketFrame
import io.netty.handler.codec.http.websocketx.WebSocketFrameAggregator
import io.netty.handler.codec.http.websocketx.WebSocketServerProtocolConfig
import io.netty.handler.codec.http.websocketx.WebSocketServerProtocolHandler
import io.netty.util.AttributeKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel as KChannel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import java.net.InetSocketAddress
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * A real WebSocket host for [HypenServer] on Netty (test harness): the
 * upgrade request goes through [HypenServer.admit] BEFORE the handshake
 * (403 on refusal, RFC 001 §5), no permessage-deflate extension is offered
 * (the harness keeps frames raw; per-message compression is covered by
 * `HypenServerDeviceTest`), accepted sockets are driven with
 * [HypenServer.openConnection] / [HypenServer.handleMessage] /
 * [HypenServer.handleBinary] / [HypenServer.handleDisconnect], in order,
 * one coroutine per connection.
 */
class NettyHypenWebSocketServer(private val server: HypenServer, private val path: String = "/ws", private val listenPort: Int = 0) : AutoCloseable {
    private val boss = NioEventLoopGroup(1)
    private val workers = NioEventLoopGroup(2)
    private val scope = CoroutineScope(Dispatchers.Default + SupervisorJob())
    private val channel: Channel
    private val inboxKey = AttributeKey.valueOf<KChannel<Any>>("hypen.inbox")

    /** Every upgrade verdict, in order (for assertions). */
    val admissions: MutableList<Admission> = java.util.Collections.synchronizedList(mutableListOf())

    val port: Int get() = (channel.localAddress() as InetSocketAddress).port

    val url: String get() = "ws://127.0.0.1:$port$path"

    private object Disconnected

    init {
        channel = ServerBootstrap()
            .group(boss, workers)
            .channel(NioServerSocketChannel::class.java)
            .childHandler(object : ChannelInitializer<SocketChannel>() {
                override fun initChannel(ch: SocketChannel) {
                    ch.pipeline()
                        .addLast(HttpServerCodec())
                        .addLast(HttpObjectAggregator(1 shl 16))
                        .addLast(Admit())
                        .addLast(
                            WebSocketServerProtocolHandler(
                                WebSocketServerProtocolConfig.newBuilder()
                                    .websocketPath(path)
                                    .allowExtensions(false)
                                    .maxFramePayloadLength(16 shl 20)
                                    .handleCloseFrames(true)
                                    .build(),
                            ),
                        )
                        .addLast(WebSocketFrameAggregator(16 shl 20))
                        .addLast(Frames())
                }
            })
            .bind("127.0.0.1", listenPort)
            .sync()
            .channel()
    }

    /** Upgrade admission before the handshake. */
    private inner class Admit : SimpleChannelInboundHandler<FullHttpRequest>(false) {
        override fun channelRead0(ctx: ChannelHandlerContext, req: FullHttpRequest) {
            val headers = req.headers().names().associateWith { req.headers().getAll(it) }
            scope.launch {
                val verdict = server.admit(UpgradeRequest(headers, req.uri(), ctx.channel().remoteAddress()?.toString()))
                admissions += verdict
                ctx.channel().eventLoop().execute {
                    if (verdict is Admission.Rejected) {
                        val body = Unpooled.copiedBuffer("Forbidden", Charsets.UTF_8)
                        val res = DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.valueOf(verdict.status), body)
                        res.headers().set(HttpHeaderNames.CONTENT_LENGTH, body.readableBytes())
                        req.release()
                        ctx.writeAndFlush(res).addListener(ChannelFutureListener.CLOSE)
                    } else {
                        ctx.fireChannelRead(req)
                    }
                }
            }
        }
    }

    /** Frames of an upgraded socket, forwarded to the server in order. */
    private inner class Frames : SimpleChannelInboundHandler<WebSocketFrame>() {
        override fun userEventTriggered(ctx: ChannelHandlerContext, evt: Any) {
            if (evt is WebSocketServerProtocolHandler.HandshakeComplete) {
                val ch = ctx.channel()
                val inbox = KChannel<Any>(KChannel.UNLIMITED)
                ch.attr(inboxKey).set(inbox)
                server.openConnection(ch, NettyTransport(ch))
                scope.launch {
                    for (m in inbox) {
                        when (m) {
                            is String -> server.handleMessage(ch, m) {}
                            is ByteArray -> server.handleBinary(ch, m)
                            Disconnected -> {
                                server.handleDisconnect(ch)
                                break
                            }
                        }
                    }
                }
            }
            super.userEventTriggered(ctx, evt)
        }

        override fun channelRead0(ctx: ChannelHandlerContext, frame: WebSocketFrame) {
            val inbox = ctx.channel().attr(inboxKey).get() ?: return
            when (frame) {
                is TextWebSocketFrame -> inbox.trySend(frame.text())
                is BinaryWebSocketFrame -> inbox.trySend(ByteBufUtil.getBytes(frame.content()))
                else -> {}
            }
        }

        override fun channelInactive(ctx: ChannelHandlerContext) {
            ctx.channel().attr(inboxKey).get()?.trySend(Disconnected)
            super.channelInactive(ctx)
        }

        @Suppress("OVERRIDE_DEPRECATION")
        override fun exceptionCaught(ctx: ChannelHandlerContext, cause: Throwable) {
            ctx.close()
        }
    }

    private class NettyTransport(private val ch: Channel) : HypenTransport {
        override suspend fun sendText(text: String) = ch.writeAndFlush(TextWebSocketFrame(text)).awaitWrite()

        override suspend fun sendBinary(bytes: ByteArray) = ch.writeAndFlush(BinaryWebSocketFrame(Unpooled.wrappedBuffer(bytes))).awaitWrite()

        override suspend fun close(code: Int, reason: String) {
            if (ch.isActive) ch.writeAndFlush(CloseWebSocketFrame(code, reason)).awaitWrite()
            ch.close()
        }

        /** Bytes Netty accepted but has not written to the socket yet. */
        override fun bufferedAmount(): Long = ch.unsafe().outboundBuffer()?.totalPendingWriteBytes() ?: 0L

        private suspend fun ChannelFuture.awaitWrite() {
            suspendCancellableCoroutine<Unit> { cont ->
                addListener { f ->
                    if (f.isSuccess) cont.resume(Unit) else cont.resumeWithException(f.cause() ?: IllegalStateException("write failed"))
                }
            }
        }
    }

    override fun close() {
        channel.close().syncUninterruptibly()
        scope.cancel()
        workers.shutdownGracefully(0, 1, java.util.concurrent.TimeUnit.SECONDS)
        boss.shutdownGracefully(0, 1, java.util.concurrent.TimeUnit.SECONDS)
    }
}
