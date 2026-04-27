package space.hypen.renderer.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import space.hypen.renderer.model.HypenElement

/**
 * Renders a server-resolved icon from pre-resolved SVG path data.
 *
 * The engine resolves `Icon("heart")` into concrete SVG paths at render time,
 * injecting `__iconPaths` and `__iconViewBox` props. This component reads those
 * pre-resolved props and draws the icon using Android Canvas/Path.
 */
class IconComponent : ComponentHandler {
    override val typeName: String = "icon"

    @Composable
    override fun Render(
        element: HypenElement,
        modifier: Modifier,
        renderChildren: @Composable () -> Unit,
    ) {
        val iconPaths = element.props["__iconPaths"] as? List<*>
            ?: element.props["__iconPaths.0"] as? List<*>

        val viewBoxStr = element.getStringProp("__iconViewBox.0")
            ?: element.getStringProp("__iconViewBox")
            ?: "0 0 24 24"

        val size = element.getFloatProp("size.0")
            ?: element.getFloatProp("size")
            ?: 24f

        val colorStr = element.getStringProp("color.0")
            ?: element.getStringProp("color")

        val color = colorStr?.let { parseColor(it) } ?: Color.Unspecified

        val viewBox = remember(viewBoxStr) { parseViewBox(viewBoxStr) }

        if (iconPaths != null && iconPaths.isNotEmpty()) {
            val parsedPaths = remember(iconPaths) {
                iconPaths.mapNotNull { it as? Map<*, *> }.map { pathData ->
                    IconPathData(
                        d = pathData["d"] as? String ?: "",
                        fill = pathData["fill"] as? String ?: "none",
                        stroke = pathData["stroke"] as? String ?: "currentColor",
                        strokeWidth = (pathData["strokeWidth"] as? Number)?.toFloat() ?: 2f,
                        strokeLinecap = pathData["strokeLinecap"] as? String ?: "round",
                        strokeLinejoin = pathData["strokeLinejoin"] as? String ?: "round",
                    )
                }
            }

            Canvas(
                modifier = modifier.size(size.dp)
            ) {
                val scaleX = this.size.width / viewBox.width
                val scaleY = this.size.height / viewBox.height

                for (pathData in parsedPaths) {
                    val path = parseSVGPath(pathData.d, scaleX, scaleY)

                    val resolvedColor = if (color != Color.Unspecified) color else Color.Black

                    // Fill
                    if (pathData.fill != "none") {
                        val fillColor = if (pathData.fill == "currentColor") resolvedColor
                        else parseColor(pathData.fill) ?: resolvedColor
                        drawPath(path, fillColor)
                    }

                    // Stroke
                    if (pathData.stroke != "none") {
                        val strokeColor = if (pathData.stroke == "currentColor") resolvedColor
                        else parseColor(pathData.stroke) ?: resolvedColor

                        val cap = when (pathData.strokeLinecap) {
                            "round" -> StrokeCap.Round
                            "square" -> StrokeCap.Square
                            else -> StrokeCap.Butt
                        }
                        val join = when (pathData.strokeLinejoin) {
                            "round" -> StrokeJoin.Round
                            "bevel" -> StrokeJoin.Bevel
                            else -> StrokeJoin.Miter
                        }

                        drawPath(
                            path,
                            strokeColor,
                            style = Stroke(
                                width = pathData.strokeWidth * scaleX,
                                cap = cap,
                                join = join,
                            )
                        )
                    }
                }
            }
        }
    }

    private data class IconPathData(
        val d: String,
        val fill: String,
        val stroke: String,
        val strokeWidth: Float,
        val strokeLinecap: String,
        val strokeLinejoin: String,
    )

    private data class ViewBox(
        val x: Float = 0f,
        val y: Float = 0f,
        val width: Float = 24f,
        val height: Float = 24f,
    )

    private fun parseViewBox(str: String): ViewBox {
        val parts = str.split(" ").mapNotNull { it.toFloatOrNull() }
        return if (parts.size == 4) {
            ViewBox(parts[0], parts[1], parts[2], parts[3])
        } else {
            ViewBox()
        }
    }

    private fun parseColor(str: String): Color? {
        return try {
            when {
                str.startsWith("#") -> {
                    val hex = str.removePrefix("#")
                    when (hex.length) {
                        3 -> {
                            val r = hex[0].toString().repeat(2).toInt(16)
                            val g = hex[1].toString().repeat(2).toInt(16)
                            val b = hex[2].toString().repeat(2).toInt(16)
                            Color(r, g, b)
                        }
                        6 -> Color(android.graphics.Color.parseColor(str))
                        8 -> Color(android.graphics.Color.parseColor(str))
                        else -> null
                    }
                }
                str.startsWith("rgb") -> null // Simplified — could parse rgb() later
                str == "black" -> Color.Black
                str == "white" -> Color.White
                str == "red" -> Color.Red
                str == "green" -> Color.Green
                str == "blue" -> Color.Blue
                str == "gray" || str == "grey" -> Color.Gray
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }

    /**
     * Parse a subset of SVG path commands into an Android [Path].
     * Supports: M, m, L, l, H, h, V, v, C, c, S, s, Q, q, Z, z, A, a
     */
    private fun parseSVGPath(d: String, scaleX: Float, scaleY: Float): Path {
        val path = Path()
        val tokens = tokenize(d)
        var i = 0
        var cx = 0f
        var cy = 0f
        var lastCmd = ' '
        var lastCpX = 0f
        var lastCpY = 0f

        fun sx(v: Float) = v * scaleX
        fun sy(v: Float) = v * scaleY
        fun nextFloat(): Float? = if (i < tokens.size) tokens[i++].toFloatOrNull() else null

        while (i < tokens.size) {
            val token = tokens[i]
            val cmd = if (token.length == 1 && token[0].isLetter()) {
                i++
                token[0]
            } else {
                // Implicit repeat
                lastCmd
            }

            when (cmd) {
                'M' -> {
                    val x = nextFloat() ?: break; val y = nextFloat() ?: break
                    path.moveTo(sx(x), sy(y)); cx = x; cy = y; lastCmd = 'L'
                }
                'm' -> {
                    val dx = nextFloat() ?: break; val dy = nextFloat() ?: break
                    cx += dx; cy += dy; path.moveTo(sx(cx), sy(cy)); lastCmd = 'l'
                }
                'L' -> {
                    val x = nextFloat() ?: break; val y = nextFloat() ?: break
                    path.lineTo(sx(x), sy(y)); cx = x; cy = y; lastCmd = 'L'
                }
                'l' -> {
                    val dx = nextFloat() ?: break; val dy = nextFloat() ?: break
                    cx += dx; cy += dy; path.lineTo(sx(cx), sy(cy)); lastCmd = 'l'
                }
                'H' -> {
                    val x = nextFloat() ?: break
                    path.lineTo(sx(x), sy(cy)); cx = x; lastCmd = 'H'
                }
                'h' -> {
                    val dx = nextFloat() ?: break
                    cx += dx; path.lineTo(sx(cx), sy(cy)); lastCmd = 'h'
                }
                'V' -> {
                    val y = nextFloat() ?: break
                    path.lineTo(sx(cx), sy(y)); cy = y; lastCmd = 'V'
                }
                'v' -> {
                    val dy = nextFloat() ?: break
                    cy += dy; path.lineTo(sx(cx), sy(cy)); lastCmd = 'v'
                }
                'C' -> {
                    val x1 = nextFloat() ?: break; val y1 = nextFloat() ?: break
                    val x2 = nextFloat() ?: break; val y2 = nextFloat() ?: break
                    val x = nextFloat() ?: break; val y = nextFloat() ?: break
                    path.cubicTo(sx(x1), sy(y1), sx(x2), sy(y2), sx(x), sy(y))
                    lastCpX = x2; lastCpY = y2; cx = x; cy = y; lastCmd = 'C'
                }
                'c' -> {
                    val dx1 = nextFloat() ?: break; val dy1 = nextFloat() ?: break
                    val dx2 = nextFloat() ?: break; val dy2 = nextFloat() ?: break
                    val dx = nextFloat() ?: break; val dy = nextFloat() ?: break
                    path.cubicTo(
                        sx(cx + dx1), sy(cy + dy1),
                        sx(cx + dx2), sy(cy + dy2),
                        sx(cx + dx), sy(cy + dy)
                    )
                    lastCpX = cx + dx2; lastCpY = cy + dy2
                    cx += dx; cy += dy; lastCmd = 'c'
                }
                'S' -> {
                    val x2 = nextFloat() ?: break; val y2 = nextFloat() ?: break
                    val x = nextFloat() ?: break; val y = nextFloat() ?: break
                    val rx = 2 * cx - lastCpX; val ry = 2 * cy - lastCpY
                    path.cubicTo(sx(rx), sy(ry), sx(x2), sy(y2), sx(x), sy(y))
                    lastCpX = x2; lastCpY = y2; cx = x; cy = y; lastCmd = 'S'
                }
                's' -> {
                    val dx2 = nextFloat() ?: break; val dy2 = nextFloat() ?: break
                    val dx = nextFloat() ?: break; val dy = nextFloat() ?: break
                    val rx = 2 * cx - lastCpX; val ry = 2 * cy - lastCpY
                    path.cubicTo(sx(rx), sy(ry), sx(cx + dx2), sy(cy + dy2), sx(cx + dx), sy(cy + dy))
                    lastCpX = cx + dx2; lastCpY = cy + dy2
                    cx += dx; cy += dy; lastCmd = 's'
                }
                'Q' -> {
                    val x1 = nextFloat() ?: break; val y1 = nextFloat() ?: break
                    val x = nextFloat() ?: break; val y = nextFloat() ?: break
                    path.quadraticBezierTo(sx(x1), sy(y1), sx(x), sy(y))
                    lastCpX = x1; lastCpY = y1; cx = x; cy = y; lastCmd = 'Q'
                }
                'q' -> {
                    val dx1 = nextFloat() ?: break; val dy1 = nextFloat() ?: break
                    val dx = nextFloat() ?: break; val dy = nextFloat() ?: break
                    path.quadraticBezierTo(sx(cx + dx1), sy(cy + dy1), sx(cx + dx), sy(cy + dy))
                    lastCpX = cx + dx1; lastCpY = cy + dy1
                    cx += dx; cy += dy; lastCmd = 'q'
                }
                'A', 'a' -> {
                    val isRel = cmd == 'a'
                    val rx = nextFloat() ?: break
                    val ry = nextFloat() ?: break
                    val rot = nextFloat() ?: break
                    val largeArc = (nextFloat() ?: break) != 0f
                    val sweep = (nextFloat() ?: break) != 0f
                    val ex = nextFloat() ?: break
                    val ey = nextFloat() ?: break
                    val x1 = cx
                    val y1 = cy
                    val x2 = if (isRel) cx + ex else ex
                    val y2 = if (isRel) cy + ey else ey
                    if (rx == 0f || ry == 0f) {
                        path.lineTo(sx(x2), sy(y2))
                    } else {
                        val segs = arcToCubicBeziers(x1, y1, x2, y2, rx, ry, rot, largeArc, sweep)
                        for (s in segs) {
                            path.cubicTo(
                                sx(s.cp1x), sy(s.cp1y),
                                sx(s.cp2x), sy(s.cp2y),
                                sx(s.x), sy(s.y),
                            )
                        }
                    }
                    cx = x2; cy = y2; lastCmd = cmd
                }
                'Z', 'z' -> {
                    path.close(); lastCmd = cmd
                }
                else -> { i++; continue }
            }
        }

        return path
    }

    private fun tokenize(d: String): List<String> {
        val tokens = mutableListOf<String>()
        val current = StringBuilder()

        for (ch in d) {
            when {
                ch.isLetter() -> {
                    if (current.isNotEmpty()) { tokens.add(current.toString()); current.clear() }
                    tokens.add(ch.toString())
                }
                ch == ',' || ch == ' ' || ch == '\t' || ch == '\n' || ch == '\r' -> {
                    if (current.isNotEmpty()) { tokens.add(current.toString()); current.clear() }
                }
                ch == '-' && current.isNotEmpty() && current.last() != 'e' && current.last() != 'E' -> {
                    tokens.add(current.toString()); current.clear(); current.append(ch)
                }
                // Second decimal point mid-number (`.621.504` → `.621`, `.504`).
                // Heroicons paths pack numbers this way; without splitting here the
                // Double parse fails and entire path segments get silently dropped.
                ch == '.' && current.contains('.') -> {
                    tokens.add(current.toString()); current.clear(); current.append(ch)
                }
                else -> current.append(ch)
            }
        }
        if (current.isNotEmpty()) tokens.add(current.toString())
        return tokens
    }

    private data class CubicSegment(
        val cp1x: Float, val cp1y: Float,
        val cp2x: Float, val cp2y: Float,
        val x: Float, val y: Float,
    )

    private fun arcToCubicBeziers(
        x1: Float, y1: Float,
        x2: Float, y2: Float,
        rxIn: Float, ryIn: Float,
        xAxisRotationDeg: Float,
        largeArcFlag: Boolean,
        sweepFlag: Boolean,
    ): List<CubicSegment> {
        if (rxIn == 0f || ryIn == 0f) {
            return listOf(CubicSegment(x2, y2, x2, y2, x2, y2))
        }
        val phi = Math.toRadians(xAxisRotationDeg.toDouble())
        val cosPhi = Math.cos(phi)
        val sinPhi = Math.sin(phi)
        val dx = ((x1 - x2) / 2.0)
        val dy = ((y1 - y2) / 2.0)
        val x1p = cosPhi * dx + sinPhi * dy
        val y1p = -sinPhi * dx + cosPhi * dy
        var rx = Math.abs(rxIn.toDouble())
        var ry = Math.abs(ryIn.toDouble())
        val lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
        if (lambda > 1) {
            val s = Math.sqrt(lambda)
            rx *= s
            ry *= s
        }
        val sign = if (largeArcFlag == sweepFlag) -1.0 else 1.0
        val sq = Math.max(
            0.0,
            (rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p) /
                (rx * rx * y1p * y1p + ry * ry * x1p * x1p)
        )
        val coef = sign * Math.sqrt(sq)
        val cxp = (coef * rx * y1p) / ry
        val cyp = (-coef * ry * x1p) / rx
        val cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2.0
        val cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2.0
        fun angle(ux: Double, uy: Double, vx: Double, vy: Double): Double {
            val dot = ux * vx + uy * vy
            val len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy))
            var a = Math.acos(Math.min(1.0, Math.max(-1.0, dot / len)))
            if (ux * vy - uy * vx < 0) a = -a
            return a
        }
        val theta1 = angle(1.0, 0.0, (x1p - cxp) / rx, (y1p - cyp) / ry)
        var deltaTheta = angle(
            (x1p - cxp) / rx,
            (y1p - cyp) / ry,
            (-x1p - cxp) / rx,
            (-y1p - cyp) / ry,
        )
        if (!sweepFlag && deltaTheta > 0) deltaTheta -= 2 * Math.PI
        else if (sweepFlag && deltaTheta < 0) deltaTheta += 2 * Math.PI
        val numSegs = Math.ceil(Math.abs(deltaTheta) / (Math.PI / 2)).toInt().coerceAtLeast(1)
        val delta = deltaTheta / numSegs
        val t = (8.0 / 3.0) * Math.sin(delta / 4) * Math.sin(delta / 4) / Math.sin(delta / 2)
        val result = mutableListOf<CubicSegment>()
        var theta = theta1
        var startX = x1.toDouble()
        var startY = y1.toDouble()
        for (i in 0 until numSegs) {
            val theta2 = theta + delta
            val cosT1 = Math.cos(theta)
            val sinT1 = Math.sin(theta)
            val cosT2 = Math.cos(theta2)
            val sinT2 = Math.sin(theta2)
            val endX = cosPhi * rx * cosT2 - sinPhi * ry * sinT2 + cx
            val endY = sinPhi * rx * cosT2 + cosPhi * ry * sinT2 + cy
            val cp1x = startX + t * (-cosPhi * rx * sinT1 - sinPhi * ry * cosT1)
            val cp1y = startY + t * (-sinPhi * rx * sinT1 + cosPhi * ry * cosT1)
            val cp2x = endX + t * (cosPhi * rx * sinT2 + sinPhi * ry * cosT2)
            val cp2y = endY + t * (sinPhi * rx * sinT2 - cosPhi * ry * cosT2)
            result.add(
                CubicSegment(
                    cp1x.toFloat(), cp1y.toFloat(),
                    cp2x.toFloat(), cp2y.toFloat(),
                    endX.toFloat(), endY.toFloat(),
                )
            )
            theta = theta2
            startX = endX
            startY = endY
        }
        return result
    }
}
