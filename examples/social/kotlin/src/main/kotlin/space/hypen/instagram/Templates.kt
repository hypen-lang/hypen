package space.hypen.instagram

import java.io.File

fun loadTemplate(name: String): String {
    val componentsDir = File("../components")
    return File(componentsDir, "$name/component.hypen").readText()
}
