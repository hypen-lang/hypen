import XCTest
@testable import HypenServer

// MARK: - ComponentLoader Tests

final class ComponentLoaderTests: XCTestCase {
    func testRegisterAndGet() {
        let loader = ComponentLoader()
        loader.register("Button", template: "Button(\"Click\")")

        XCTAssertTrue(loader.has("Button"))
        XCTAssertFalse(loader.has("Card"))

        let def = loader.get("Button")
        XCTAssertEqual(def?.name, "Button")
        XCTAssertEqual(def?.template, "Button(\"Click\")")
    }

    func testRegisterWithModule() {
        let loader = ComponentLoader()
        let module = AppBuilder(["count": 0]).build()
        loader.register("Counter", module: module, template: "Text(\"@{state.count}\")")

        let def = loader.get("Counter")
        XCTAssertNotNil(def?.module)
        XCTAssertEqual(def?.module?.initialState["count"] as? Int, 0)
    }

    func testGetNames() {
        let loader = ComponentLoader()
        loader.register("A", template: "A")
        loader.register("B", template: "B")
        loader.register("C", template: "C")

        XCTAssertEqual(Set(loader.getNames()), Set(["A", "B", "C"]))
    }

    func testGetAll() {
        let loader = ComponentLoader()
        loader.register("A", template: "A")
        loader.register("B", template: "B")

        XCTAssertEqual(loader.getAll().count, 2)
    }

    func testClear() {
        let loader = ComponentLoader()
        loader.register("A", template: "A")
        XCTAssertTrue(loader.has("A"))

        loader.clear()
        XCTAssertFalse(loader.has("A"))
        XCTAssertEqual(loader.getAll().count, 0)
    }

    func testRegisterDefinition() {
        let loader = ComponentLoader()
        let def = ComponentDefinition(name: "Card", template: "Column { }")
        loader.register(def)

        XCTAssertTrue(loader.has("Card"))
        XCTAssertEqual(loader.get("Card")?.template, "Column { }")
    }
}

// MARK: - Import Parsing Tests

final class ImportParsingTests: XCTestCase {
    func testParseNamedImport() {
        let imports = parseImports("import { Button } from \"./button\"")
        XCTAssertEqual(imports.count, 1)

        let stmt = imports[0]
        XCTAssertEqual(stmt.clause.type, .named)
        XCTAssertEqual(stmt.clause.names, ["Button"])

        if case .local(let path) = stmt.source {
            XCTAssertEqual(path, "./button")
        } else {
            XCTFail("Expected local source")
        }
    }

    func testParseMultipleNamedImports() {
        let imports = parseImports("import { Button, Card, Input } from \"./components\"")
        XCTAssertEqual(imports.count, 1)
        XCTAssertEqual(imports[0].clause.names, ["Button", "Card", "Input"])
    }

    func testParseDefaultImport() {
        let imports = parseImports("import HomePage from \"./home\"")
        XCTAssertEqual(imports.count, 1)
        XCTAssertEqual(imports[0].clause.type, .default)
        XCTAssertEqual(imports[0].clause.name, "HomePage")
    }

    func testParseURLImport() {
        let imports = parseImports("import Widget from \"https://example.com/widget.hypen\"")
        XCTAssertEqual(imports.count, 1)

        if case .url(let url) = imports[0].source {
            XCTAssertEqual(url, "https://example.com/widget.hypen")
        } else {
            XCTFail("Expected URL source")
        }
    }

    func testParseMultipleStatements() {
        let text = """
        import { Button } from "./button"
        import Card from "./card"
        import { Input, Select } from "https://cdn.example.com/forms"
        """
        let imports = parseImports(text)
        XCTAssertEqual(imports.count, 3)
    }

    func testRemoveImports() {
        let text = """
        import { Button } from "./button"
        Column {
            Button("Click")
        }
        """
        let cleaned = removeImports(text)
        XCTAssertFalse(cleaned.contains("import"))
        XCTAssertTrue(cleaned.contains("Column"))
    }

    func testParseSingleQuotes() {
        let imports = parseImports("import Button from './button'")
        XCTAssertEqual(imports.count, 1)
        XCTAssertEqual(imports[0].clause.name, "Button")
    }
}

// MARK: - ComponentResolver Tests

final class ComponentResolverTests: XCTestCase {
    func testResolveFromRegistry() throws {
        let app = HypenApp()
        let _ = app.module("Button").defineState(["label": "Click"]).build()

        let resolver = ComponentResolver(options: ResolverOptions(app: app))
        let stmt = ImportStatement(
            clause: .default("Button"),
            source: .local(path: "./button")
        )

        let result = try resolver.resolve(stmt)
        XCTAssertNotNil(result["Button"])
        XCTAssertNotNil(result["Button"]?.module)
    }

    func testCacheSize() throws {
        let resolver = ComponentResolver(options: ResolverOptions(cache: true))
        XCTAssertEqual(resolver.cacheSize, 0)

        resolver.clearCache()
        XCTAssertEqual(resolver.cacheSize, 0)
    }
}
