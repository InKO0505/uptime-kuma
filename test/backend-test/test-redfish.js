const { describe, test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const { RedfishMonitorType } = require("../../server/monitor-types/redfish");
const { UP } = require("../../src/util");

/**
 * Sample Redfish payloads keyed by request path, served by a local mock BMC.
 */
const payloads = {
    "/healthy-system": {
        Name: "System",
        Id: "1",
        Status: { State: "Enabled", Health: "OK", HealthRollup: "OK" },
    },
    "/degraded-rollup": {
        Name: "System",
        Status: { State: "Enabled", Health: "OK", HealthRollup: "Critical" },
    },
    "/thermal-bad-fan": {
        Name: "Thermal",
        Fans: [
            { Name: "Fan 1", Status: { State: "Enabled", Health: "OK" } },
            { Name: "Fan 2", Status: { State: "Enabled", Health: "Warning" } },
        ],
        Temperatures: [ { Name: "CPU Temp", Status: { Health: "OK" } } ],
    },
    "/power-bad-psu": {
        Name: "Power",
        PowerSupplies: [
            { Name: "PSU 1", Status: { State: "Enabled", Health: "OK" } },
            { Name: "PSU 2", Status: { State: "UnavailableOffline", Health: "Critical" } },
        ],
    },
    "/no-status": { Name: "Empty", SomethingElse: 123 },
};

describe("RedfishMonitorType", () => {
    let server;
    let baseUrl;

    before(async () => {
        server = http.createServer((req, res) => {
            // Endpoint requiring HTTP Basic auth (admin:secret).
            if (req.url === "/auth-required") {
                const expected = "Basic " + Buffer.from("admin:secret").toString("base64");
                if (req.headers.authorization !== expected) {
                    res.writeHead(401);
                    res.end("Unauthorized");
                    return;
                }
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ Name: "System", Status: { Health: "OK" } }));
                return;
            }

            const body = payloads[req.url];
            if (body === undefined) {
                res.writeHead(404);
                res.end("not found");
                return;
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(body));
        });

        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    /**
     * Build a minimal monitor bean for the given path.
     * @param {string} path Request path on the mock BMC
     * @param {object} extra Optional overrides (user, pass)
     * @returns {object} Monitor-like object accepted by check()
     */
    const monitorFor = (path, extra = {}) => ({
        name: "redfish-test",
        type: "redfish",
        url: `${baseUrl}${path}`,
        timeout: 5,
        basic_auth_user: extra.user || "",
        basic_auth_pass: extra.pass || "",
        getIgnoreTls: () => true,
    });

    test("check() sets heartbeat to UP for a healthy resource", async () => {
        const heartbeat = {};
        await new RedfishMonitorType().check(monitorFor("/healthy-system"), heartbeat, {});
        assert.strictEqual(heartbeat.status, UP);
        assert.match(heartbeat.msg, /healthy/);
        assert.strictEqual(typeof heartbeat.ping, "number");
    });

    test("check() throws when HealthRollup is degraded", async () => {
        await assert.rejects(
            () => new RedfishMonitorType().check(monitorFor("/degraded-rollup"), {}, {}),
            /Critical/
        );
    });

    test("check() names a failing fan", async () => {
        await assert.rejects(
            () => new RedfishMonitorType().check(monitorFor("/thermal-bad-fan"), {}, {}),
            /Fan 2.*Warning/
        );
    });

    test("check() names a failing power supply", async () => {
        await assert.rejects(
            () => new RedfishMonitorType().check(monitorFor("/power-bad-psu"), {}, {}),
            /PSU 2.*Critical/
        );
    });

    test("check() throws a clear error when no Status is present", async () => {
        await assert.rejects(
            () => new RedfishMonitorType().check(monitorFor("/no-status"), {}, {}),
            /No Redfish Status/
        );
    });

    test("check() fails with wrong credentials (HTTP 401)", async () => {
        await assert.rejects(
            () => new RedfishMonitorType().check(monitorFor("/auth-required", { user: "admin", pass: "wrong" }), {}, {}),
            /401/
        );
    });

    test("check() succeeds with correct credentials", async () => {
        const heartbeat = {};
        await new RedfishMonitorType().check(monitorFor("/auth-required", { user: "admin", pass: "secret" }), heartbeat, {});
        assert.strictEqual(heartbeat.status, UP);
    });

    test("check() requires a URL", async () => {
        await assert.rejects(
            () => new RedfishMonitorType().check({ timeout: 5, getIgnoreTls: () => true }, {}, {}),
            /URL is required/
        );
    });
});
