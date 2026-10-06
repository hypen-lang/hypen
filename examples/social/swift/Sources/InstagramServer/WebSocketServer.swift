import Foundation
import Network
import HypenEngineBindings

/// Minimal WebSocket server using the Network framework.
/// Implements the Hypen remote protocol (sessionAck, initialTree, dispatchAction, stateUpdate).
final class WebSocketServer: @unchecked Sendable {
    private let port: UInt16
    private let moduleName: String
    private let initialState: [String: Any]
    private let uiTemplate: String
    private let componentsDir: String
    private let onAction: @Sendable (String, [String: Any]?, inout [String: Any]) -> Void

    private var listener: NWListener?
    private let queue = DispatchQueue(label: "hypen.ws-server", attributes: .concurrent)
    private let clientQueue = DispatchQueue(label: "hypen.ws-clients")
    private var clients: [String: ClientConnection] = [:]
    private var nextClientID = 1

    init(
        port: UInt16,
        moduleName: String,
        initialState: [String: Any],
        uiTemplate: String,
        componentsDir: String,
        onAction: @escaping @Sendable (String, [String: Any]?, inout [String: Any]) -> Void
    ) {
        self.port = port
        self.moduleName = moduleName
        self.initialState = initialState
        self.uiTemplate = uiTemplate
        self.componentsDir = componentsDir
        self.onAction = onAction
    }

    func start() throws {
        let parameters = NWParameters.tcp
        let wsOptions = NWProtocolWebSocket.Options()
        parameters.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)

        listener = try NWListener(using: parameters, on: NWEndpoint.Port(rawValue: port)!)
        listener?.newConnectionHandler = { [weak self] connection in
            self?.handleNewConnection(connection)
        }
        listener?.stateUpdateHandler = { [port] state in
            switch state {
            case .ready:
                print("WebSocket server listening on port \(port)")
            case .failed(let error):
                print("Server failed: \(error)")
            default:
                break
            }
        }
        listener?.start(queue: queue)
    }

    // MARK: - Engine setup

    private func createEngine(state: [String: Any]) -> HypenEngine? {
        guard let engine = try? HypenEngine() else {
            print("Failed to create HypenEngine")
            return nil
        }

        // Register standard primitives
        let primitives = [
            "Text", "Column", "Row", "Box", "Stack", "Button", "Image",
            "Input", "Textarea", "Checkbox", "Switch", "Select", "Option",
            "Slider", "Divider", "Spacer", "Card", "Badge", "Avatar",
            "Spinner", "Icon", "Link", "LazyColumn", "LazyRow",
            "Grid", "List", "Video", "Audio", "Canvas", "WebView",
            "Router", "Route", "Modal", "Sheet", "Dialog", "Tooltip",
            "Popover", "Menu", "MenuItem", "Tab", "TabBar", "TabView",
            "NavigationBar", "Toolbar", "ToolbarItem", "Form", "Section",
            "HStack", "VStack", "ZStack",
        ]
        for p in primitives {
            engine.registerPrimitive(name: p)
        }

        // Discover and register components
        let fm = FileManager.default
        let componentsURL = URL(fileURLWithPath: componentsDir)
        if let contents = try? fm.contentsOfDirectory(at: componentsURL, includingPropertiesForKeys: nil) {
            for dir in contents where dir.hasDirectoryPath {
                let componentFile = dir.appendingPathComponent("component.hypen")
                if let source = try? String(contentsOf: componentFile, encoding: .utf8) {
                    let name = dir.lastPathComponent
                    do {
                        try engine.registerComponent(component: ComponentDef(
                            name: name,
                            source: source,
                            path: componentFile.path
                        ))
                    } catch {
                        print("Failed to register component \(name): \(error)")
                    }
                }
            }
        }

        // Set module with state
        guard let stateJSON = try? JSONSerialization.data(withJSONObject: state),
              let stateStr = String(data: stateJSON, encoding: .utf8) else {
            print("Failed to serialize state")
            return nil
        }

        let stateKeys = Array(state.keys)
        let actions = ["toggleLike", "toggleSave", "navigate", "openComments", "postComment"]

        engine.setModule(config: ModuleConfig(
            name: moduleName,
            actions: actions,
            stateKeys: stateKeys,
            initialStateJson: stateStr
        ))

        return engine
    }

    // MARK: - Connection handling

    private func handleNewConnection(_ connection: NWConnection) {
        let clientID: String = clientQueue.sync {
            let id = "client_\(nextClientID)"
            nextClientID += 1
            return id
        }

        let engine = createEngine(state: initialState)

        let client = ClientConnection(
            id: clientID,
            connection: connection,
            state: initialState,
            engine: engine
        )
        clientQueue.sync { clients[clientID] = client }

        connection.stateUpdateHandler = { [weak self, clientID] state in
            switch state {
            case .ready:
                print("Client connected: \(clientID)")
                self?.receiveMessages(client: client)
            case .failed, .cancelled:
                print("Client disconnected: \(clientID)")
                self?.clientQueue.sync { _ = self?.clients.removeValue(forKey: clientID) }
            default:
                break
            }
        }
        connection.start(queue: queue)
    }

    // MARK: - Sending messages

    private func sendSessionAckAndInitialTree(client: ClientConnection) {
        // sessionAck
        let ack: [String: Any] = [
            "type": "sessionAck",
            "sessionId": "session_\(Int(Date().timeIntervalSince1970 * 1000))",
            "isNew": true,
            "isRestored": false,
        ]
        sendJSON(client: client, value: ack)

        // Render initial patches via engine
        var patches: [[String: Any]] = []
        if let engine = client.engine {
            do {
                let enginePatches = try engine.renderSource(source: uiTemplate)
                patches = enginePatches.map { patchToDict($0) }
                print("Rendered \(patches.count) initial patches for \(client.id)")
            } catch {
                print("Engine render error: \(error)")
            }
        }

        // initialTree
        let initialTree: [String: Any] = [
            "type": "initialTree",
            "module": moduleName,
            "state": client.state,
            "patches": patches,
            "revision": 0,
        ]
        sendJSON(client: client, value: initialTree)
    }

    private func sendPatchesAndState(client: ClientConnection, patches: [[String: Any]]) {
        client.revision += 1

        if !patches.isEmpty {
            let patchMsg: [String: Any] = [
                "type": "patch",
                "module": moduleName,
                "patches": patches,
                "revision": client.revision,
            ]
            sendJSON(client: client, value: patchMsg)
        }

        let stateMsg: [String: Any] = [
            "type": "stateUpdate",
            "module": moduleName,
            "state": client.state,
            "revision": client.revision,
        ]
        sendJSON(client: client, value: stateMsg)
    }

    private func sendJSON(client: ClientConnection, value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "ws", metadata: [metadata])
        client.connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed({ error in
            if let error {
                print("Send error to \(client.id): \(error)")
            }
        }))
    }

    // MARK: - Receiving messages

    private func receiveMessages(client: ClientConnection) {
        client.connection.receiveMessage { [weak self] content, context, _, error in
            guard let self else { return }
            if let error {
                print("Receive error from \(client.id): \(error)")
                return
            }

            if let data = content, let context,
               let wsMetadata = context.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            {
                switch wsMetadata.opcode {
                case .text:
                    self.handleTextMessage(client: client, data: data)
                case .close:
                    client.connection.cancel()
                    return
                default:
                    break
                }
            }

            // Continue receiving
            self.receiveMessages(client: client)
        }
    }

    private func handleTextMessage(client: ClientConnection, data: Data) {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String
        else { return }

        switch type {
        case "hello":
            sendSessionAckAndInitialTree(client: client)

        case "dispatchAction":
            guard let action = json["action"] as? String else { return }
            let payload = json["payload"] as? [String: Any]
            onAction(action, payload, &client.state)

            // Re-render via engine
            var patches: [[String: Any]] = []
            if let engine = client.engine {
                do {
                    guard let stateJSON = try? JSONSerialization.data(withJSONObject: client.state),
                          let stateStr = String(data: stateJSON, encoding: .utf8) else { return }
                    let enginePatches = try engine.updateState(stateJson: stateStr)
                    patches = enginePatches.map { patchToDict($0) }
                } catch {
                    print("Engine update error: \(error)")
                }
            }

            sendPatchesAndState(client: client, patches: patches)

        default:
            break
        }
    }
}

/// Convert a UniFFI Patch to a dictionary for JSON serialization
private func patchToDict(_ patch: HypenEngineBindings.Patch) -> [String: Any] {
    var dict: [String: Any] = ["id": patch.id]

    switch patch.patchType {
    case .create:
        dict["type"] = "create"
        if let elementType = patch.elementType { dict["elementType"] = elementType }
        if let propsJson = patch.propsJson,
           let propsData = propsJson.data(using: .utf8),
           let props = try? JSONSerialization.jsonObject(with: propsData) {
            dict["props"] = props
        }
    case .setProp:
        dict["type"] = "setProp"
        if let name = patch.name { dict["name"] = name }
        if let valueJson = patch.valueJson,
           let valueData = valueJson.data(using: .utf8),
           let value = try? JSONSerialization.jsonObject(with: valueData) {
            dict["value"] = value
        } else if let valueJson = patch.valueJson {
            // Try as a raw string
            dict["value"] = valueJson.trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        }
    case .setText:
        dict["type"] = "setText"
        if let text = patch.text { dict["text"] = text }
    case .insert:
        dict["type"] = "insert"
        if let parentId = patch.parentId { dict["parentId"] = parentId }
        if let beforeId = patch.beforeId { dict["beforeId"] = beforeId }
    case .move:
        dict["type"] = "move"
        if let parentId = patch.parentId { dict["parentId"] = parentId }
        if let beforeId = patch.beforeId { dict["beforeId"] = beforeId }
    case .remove:
        dict["type"] = "remove"
    }

    return dict
}

/// Per-client connection state
final class ClientConnection: @unchecked Sendable {
    let id: String
    let connection: NWConnection
    var state: [String: Any]
    var revision: Int = 0
    let engine: HypenEngine?

    init(id: String, connection: NWConnection, state: [String: Any], engine: HypenEngine?) {
        self.id = id
        self.connection = connection
        self.state = state
        self.engine = engine
    }
}
