import Foundation

func loadTemplate(_ name: String) -> String {
    let componentsDir = URL(fileURLWithPath: "../components")
    let path = componentsDir.appendingPathComponent("\(name)/component.hypen")
    return try! String(contentsOf: path, encoding: .utf8)
}
