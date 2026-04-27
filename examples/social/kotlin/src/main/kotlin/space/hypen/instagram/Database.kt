package space.hypen.instagram

import java.io.File
import java.sql.Connection
import java.sql.DriverManager

fun initDatabase(): Connection {
    val conn = DriverManager.getConnection("jdbc:sqlite:instagram.db")
    val dataDir = File("../data")

    conn.createStatement().executeUpdate(dataDir.resolve("schema.sql").readText())

    val count = conn.createStatement().executeQuery("SELECT COUNT(*) FROM users")
    count.next()
    if (count.getInt(1) == 0) {
        conn.createStatement().executeUpdate(dataDir.resolve("seed.sql").readText())
        println("Database seeded")
    }

    return conn
}

fun formatTimeAgo(dateStr: String): String {
    return try {
        val sdf = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss")
        val date = sdf.parse(dateStr)
        val diffMs = System.currentTimeMillis() - (date?.time ?: 0)
        val diffMin = (diffMs / 60000).toInt()
        when {
            diffMin < 60 -> "${diffMin}m"
            diffMin < 1440 -> "${diffMin / 60}h"
            else -> "${diffMin / 1440}d"
        }
    } catch (e: Exception) {
        dateStr
    }
}
