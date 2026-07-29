const { MonitorType } = require("./monitor-type");
const { UP, log } = require("../../src/util");
const axios = require("axios");
const https = require("https");

/**
 * A monitor that queries a Redfish/DMTF endpoint on a server's BMC
 * (e.g. /redfish/v1/Systems/1 or /redfish/v1/Chassis/1/Thermal) and reports
 * DOWN when the reported hardware health is not "OK".
 *
 * It inspects two things in the JSON response:
 *  1. The resource-level Status (HealthRollup preferred, otherwise Health).
 *  2. Any well-known component arrays present in the response
 *     (power supplies, fans, temperatures, voltages, processors, memory,
 *     drives), so a failing PSU/fan/thermal sensor is named in the alert.
 *
 * Existing monitor fields are reused instead of adding new DB columns:
 *  - url                              -> full Redfish resource URL
 *  - basic_auth_user / basic_auth_pass -> BMC credentials (HTTP Basic auth)
 *  - ignoreTls                        -> accept self-signed BMC certificates
 */
class RedfishMonitorType extends MonitorType {
    name = "redfish";

    /**
     * Component arrays defined by the Redfish schema that carry a per-item
     * Status object. Checking these lets us pinpoint the failing part.
     * @type {string[]}
     */
    componentArrays = [
        "PowerSupplies",
        "Fans",
        "Temperatures",
        "Voltages",
        "Processors",
        "Memory",
        "Drives",
    ];

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        if (!monitor.url) {
            throw new Error("Redfish resource URL is required (e.g. https://bmc.example.com/redfish/v1/Systems/1)");
        }

        const options = {
            method: "GET",
            url: monitor.url,
            timeout: monitor.timeout * 1000,
            headers: {
                "Accept": "application/json",
            },
            httpsAgent: new https.Agent({
                // BMCs almost always ship self-signed certificates, so honour
                // the monitor's "Ignore TLS/SSL error" checkbox.
                rejectUnauthorized: !monitor.getIgnoreTls(),
            }),
        };

        // Redfish requires authentication on most endpoints; send HTTP Basic
        // auth when credentials are configured.
        if (monitor.basic_auth_user || monitor.basic_auth_pass) {
            options.auth = {
                username: monitor.basic_auth_user,
                password: monitor.basic_auth_pass,
            };
        }

        const startTime = Date.now();
        const res = await axios(options);
        heartbeat.ping = Date.now() - startTime;

        const data = res.data;
        if (!data || typeof data !== "object") {
            throw new Error("Redfish endpoint did not return a JSON object");
        }

        const problems = [];
        let checked = 0;

        /**
         * Record a component whose health is not OK.
         * A missing/null Health is treated as "not reported" and ignored,
         * which matches how Redfish implementations omit Status on absent
         * or not-yet-populated resources.
         * @param {string} label Human-readable component name for the alert
         * @param {object} status Redfish Status object ({ Health, State, ... })
         * @param {string} health Explicit health value to use instead of status.Health
         * @returns {void}
         */
        const record = (label, status, health) => {
            if (!status) {
                return;
            }
            const value = health ?? status.Health;
            if (value == null) {
                return;
            }
            checked++;
            if (value !== "OK") {
                const state = status.State ? ` (${status.State})` : "";
                problems.push(`${label}: ${value}${state}`);
            }
        };

        // 1. Resource-level health. HealthRollup aggregates subordinate
        //    resources, so prefer it when present.
        if (data.Status) {
            const label = data.Name || data.Id || "Resource";
            record(label, data.Status, data.Status.HealthRollup ?? data.Status.Health);
        }

        // 2. Per-component arrays (PSUs, fans, sensors, ...).
        for (const key of this.componentArrays) {
            if (!Array.isArray(data[key])) {
                continue;
            }
            data[key].forEach((item, index) => {
                if (!item || typeof item !== "object") {
                    return;
                }
                const name = item.Name || item.MemberId || `${key}[${index}]`;
                record(name, item.Status);
            });
        }

        if (checked === 0) {
            throw new Error("No Redfish Status/Health information found in the response (check the resource URL)");
        }

        if (problems.length > 0) {
            throw new Error(`Redfish health degraded → ${problems.join("; ")}`);
        }

        heartbeat.status = UP;
        heartbeat.msg = `Redfish healthy (${checked} component${checked === 1 ? "" : "s"} OK)`;
        log.debug("monitor", `[${monitor.name}] Redfish check passed: ${checked} component(s) OK`);
    }
}

module.exports = {
    RedfishMonitorType,
};
