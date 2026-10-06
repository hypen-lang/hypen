package space.hypen.renderer.components

/**
 * `Path(d: "M0,0 L10,10")` — the chart family's escape hatch.
 *
 * The `d` string's coordinates are DATA units, so the parser normalises every
 * command to absolute `M`/`L`/`C`/`Q`/`Z` in data space and the caller pushes
 * them through the chart's one affine transform ([chartPathTransform]). That
 * keeps the stroke width in dp — the web renderer's `vector-effect:
 * non-scaling-stroke` — instead of being squashed by the y flip.
 *
 * Supported: `M m L l H h V v C c S s Q q T t Z z`. Elliptical arcs (`A`/`a`)
 * are reduced to a straight line to their endpoint: a chart path is normally
 * computed in a module, and an arc that silently disappeared would be worse
 * than an arc drawn straight.
 */
data class ChartPathCommand(val op: Char, val coords: List<Double>)

private fun isCommand(c: Char): Boolean = c.isLetter()

/** Split a `d` string into numbers and single-letter commands. */
internal fun tokenizeChartPath(d: String): List<String> {
    val tokens = ArrayList<String>()
    val number = StringBuilder()

    fun flush() {
        if (number.isNotEmpty()) {
            tokens.add(number.toString())
            number.setLength(0)
        }
    }

    var i = 0
    while (i < d.length) {
        val c = d[i]
        when {
            isCommand(c) -> {
                // `e`/`E` directly after a digit is an exponent, not a
                // command — SVG has no such command letter.
                val previous = number.lastOrNull()
                if ((c == 'e' || c == 'E') && previous != null && (previous.isDigit() || previous == '.')) {
                    number.append(c)
                } else {
                    flush()
                    tokens.add(c.toString())
                }
            }
            c == ',' || c.isWhitespace() -> flush()
            c == '-' || c == '+' -> {
                // A sign starts a new number unless it follows an exponent.
                val previous = number.lastOrNull()
                if (number.isNotEmpty() && previous != 'e' && previous != 'E') flush()
                number.append(c)
            }
            c == '.' -> {
                // "1.5.5" is two numbers in SVG's terse form.
                if (number.contains('.')) flush()
                number.append(c)
            }
            else -> number.append(c)
        }
        i++
    }
    flush()
    return tokens
}

/**
 * Parse [d] into absolute commands. Returns an empty list when the string is
 * blank or has no usable command.
 */
fun parseChartPath(d: String): List<ChartPathCommand> {
    val tokens = tokenizeChartPath(d)
    val out = ArrayList<ChartPathCommand>()
    var i = 0
    var cx = 0.0
    var cy = 0.0
    var startX = 0.0
    var startY = 0.0
    // Reflected control point for the S/T shorthands.
    var lastControlX = 0.0
    var lastControlY = 0.0
    var lastOp = ' '
    var op = ' '

    fun next(): Double? {
        while (i < tokens.size) {
            val token = tokens[i]
            if (token.length == 1 && isCommand(token[0])) return null
            i++
            val value = token.toDoubleOrNull()
            if (value != null) return value
        }
        return null
    }

    while (i < tokens.size) {
        val token = tokens[i]
        if (token.length == 1 && isCommand(token[0])) {
            op = token[0]
            i++
        } else if (op == ' ') {
            i++
            continue
        } else if (op == 'M') {
            // Repeated coordinate pairs after a moveto are implicit linetos.
            op = 'L'
        } else if (op == 'm') {
            op = 'l'
        }

        val relative = op.isLowerCase()
        when (op.uppercaseChar()) {
            'M' -> {
                val x = next() ?: break
                val y = next() ?: break
                cx = if (relative) cx + x else x
                cy = if (relative) cy + y else y
                startX = cx
                startY = cy
                out.add(ChartPathCommand('M', listOf(cx, cy)))
            }
            'L' -> {
                val x = next() ?: break
                val y = next() ?: break
                cx = if (relative) cx + x else x
                cy = if (relative) cy + y else y
                out.add(ChartPathCommand('L', listOf(cx, cy)))
            }
            'H' -> {
                val x = next() ?: break
                cx = if (relative) cx + x else x
                out.add(ChartPathCommand('L', listOf(cx, cy)))
            }
            'V' -> {
                val y = next() ?: break
                cy = if (relative) cy + y else y
                out.add(ChartPathCommand('L', listOf(cx, cy)))
            }
            'C' -> {
                val x1 = next() ?: break
                val y1 = next() ?: break
                val x2 = next() ?: break
                val y2 = next() ?: break
                val x = next() ?: break
                val y = next() ?: break
                val c1x = if (relative) cx + x1 else x1
                val c1y = if (relative) cy + y1 else y1
                val c2x = if (relative) cx + x2 else x2
                val c2y = if (relative) cy + y2 else y2
                cx = if (relative) cx + x else x
                cy = if (relative) cy + y else y
                lastControlX = c2x
                lastControlY = c2y
                out.add(ChartPathCommand('C', listOf(c1x, c1y, c2x, c2y, cx, cy)))
            }
            'S' -> {
                val x2 = next() ?: break
                val y2 = next() ?: break
                val x = next() ?: break
                val y = next() ?: break
                val reflect = lastOp == 'C' || lastOp == 'S'
                val c1x = if (reflect) 2 * cx - lastControlX else cx
                val c1y = if (reflect) 2 * cy - lastControlY else cy
                val c2x = if (relative) cx + x2 else x2
                val c2y = if (relative) cy + y2 else y2
                cx = if (relative) cx + x else x
                cy = if (relative) cy + y else y
                lastControlX = c2x
                lastControlY = c2y
                out.add(ChartPathCommand('C', listOf(c1x, c1y, c2x, c2y, cx, cy)))
            }
            'Q' -> {
                val x1 = next() ?: break
                val y1 = next() ?: break
                val x = next() ?: break
                val y = next() ?: break
                val c1x = if (relative) cx + x1 else x1
                val c1y = if (relative) cy + y1 else y1
                cx = if (relative) cx + x else x
                cy = if (relative) cy + y else y
                lastControlX = c1x
                lastControlY = c1y
                out.add(ChartPathCommand('Q', listOf(c1x, c1y, cx, cy)))
            }
            'T' -> {
                val x = next() ?: break
                val y = next() ?: break
                val reflect = lastOp == 'Q' || lastOp == 'T'
                val c1x = if (reflect) 2 * cx - lastControlX else cx
                val c1y = if (reflect) 2 * cy - lastControlY else cy
                cx = if (relative) cx + x else x
                cy = if (relative) cy + y else y
                lastControlX = c1x
                lastControlY = c1y
                out.add(ChartPathCommand('Q', listOf(c1x, c1y, cx, cy)))
            }
            'A' -> {
                // rx ry rotation large-arc sweep x y — only the endpoint survives.
                next() ?: break
                next() ?: break
                next() ?: break
                next() ?: break
                next() ?: break
                val x = next() ?: break
                val y = next() ?: break
                cx = if (relative) cx + x else x
                cy = if (relative) cy + y else y
                out.add(ChartPathCommand('L', listOf(cx, cy)))
            }
            'Z' -> {
                cx = startX
                cy = startY
                out.add(ChartPathCommand('Z', emptyList()))
                // Z takes no operands; skip any stray numbers so `i` always
                // advances and the loop cannot spin.
                while (i < tokens.size && !(tokens[i].length == 1 && isCommand(tokens[i][0]))) i++
            }
            else -> {
                // Unknown command: drop its operand run rather than looping.
                while (i < tokens.size && !(tokens[i].length == 1 && isCommand(tokens[i][0]))) i++
            }
        }
        lastOp = op.uppercaseChar()
    }
    return out
}
