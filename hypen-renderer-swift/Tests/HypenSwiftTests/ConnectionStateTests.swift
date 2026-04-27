import Testing
@testable import HypenSwift

// MARK: - ConnectionState Tests

@Test func testConnectionStateIsConnected() {
    #expect(ConnectionState.connected.isConnected == true)
    #expect(ConnectionState.disconnected.isConnected == false)
    #expect(ConnectionState.connecting.isConnected == false)
    #expect(ConnectionState.reconnecting(attempt: 1).isConnected == false)
    #expect(ConnectionState.error(message: "fail").isConnected == false)
}

@Test func testConnectionStateIsConnecting() {
    #expect(ConnectionState.connecting.isConnecting == true)
    #expect(ConnectionState.reconnecting(attempt: 2).isConnecting == true)
    #expect(ConnectionState.connected.isConnecting == false)
    #expect(ConnectionState.disconnected.isConnecting == false)
    #expect(ConnectionState.error(message: "fail").isConnecting == false)
}

@Test func testConnectionStateIsError() {
    #expect(ConnectionState.error(message: "something").isError == true)
    #expect(ConnectionState.connected.isError == false)
    #expect(ConnectionState.disconnected.isError == false)
}

@Test func testConnectionStateErrorMessage() {
    #expect(ConnectionState.error(message: "timeout").errorMessage == "timeout")
    #expect(ConnectionState.connected.errorMessage == nil)
    #expect(ConnectionState.disconnected.errorMessage == nil)
}

@Test func testConnectionStateEquatable() {
    #expect(ConnectionState.connected == ConnectionState.connected)
    #expect(ConnectionState.disconnected == ConnectionState.disconnected)
    #expect(ConnectionState.connecting == ConnectionState.connecting)
    #expect(ConnectionState.reconnecting(attempt: 3) == ConnectionState.reconnecting(attempt: 3))
    #expect(ConnectionState.error(message: "a") == ConnectionState.error(message: "a"))
    #expect(ConnectionState.error(message: "a") != ConnectionState.error(message: "b"))
    #expect(ConnectionState.connected != ConnectionState.disconnected)
}

@Test func testConnectionStateDescription() {
    #expect(ConnectionState.disconnected.description == "Disconnected")
    #expect(ConnectionState.connecting.description == "Connecting...")
    #expect(ConnectionState.connected.description == "Connected")
    #expect(ConnectionState.reconnecting(attempt: 3).description == "Reconnecting (attempt 3)...")
    #expect(ConnectionState.error(message: "timeout").description == "Error: timeout")
}

@Test func testRemoteEngineConfigDefault() {
    let config = RemoteEngineConfig.default

    #expect(config.autoReconnect == true)
    #expect(config.maxReconnectAttempts == 10)
    #expect(config.reconnectInterval == 3.0)
    #expect(config.connectTimeout == 10.0)
    #expect(config.readTimeout == 30.0)
    #expect(config.writeTimeout == 10.0)
    #expect(config.pingInterval == 30.0)
    #expect(config.debugLogging == false)
}

@Test func testRemoteEngineConfigDebug() {
    let config = RemoteEngineConfig.debug

    #expect(config.debugLogging == true)
    #expect(config.autoReconnect == true)
}

@Test func testRemoteEngineConfigNoReconnect() {
    let config = RemoteEngineConfig.noReconnect

    #expect(config.autoReconnect == false)
}
