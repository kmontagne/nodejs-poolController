import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import { sys } from "../../../controller/Equipment";
import { state } from "../../../controller/State";
import { getCoordinatesForZip } from "../../../controller/zipCoords";
import { logger } from "../../../logger/Logger";

export interface TempHistoryPoint {
    ts: number;
    pool?: number;
    spa?: number;
    glacier?: number;
    air?: number;
    dewPoint?: number;
}

class TempHistoryService {
    private readonly _sampleMs = 5 * 60 * 1000;
    private readonly _dewPointFetchMs = 15 * 60 * 1000;
    private readonly _retentionMs = 120 * 24 * 60 * 60 * 1000;
    private readonly _file = path.join(process.cwd(), "data", "temp-history.jsonl");
    private _timer: NodeJS.Timeout;
    private _lastDewPointFetch = 0;
    private _latestDewPoint: number;
    private _dewPointChangeHandlers: Array<(dewPoint: number) => void> = [];
    private _started = false;

    public start() {
        if (this._started) return;
        this._started = true;
        this.ensureDataDir();
        this.capture().catch(err => logger.error(`Temperature history capture error: ${err?.message || err}`));
        this._timer = setInterval(() => {
            this.capture().catch(err => logger.error(`Temperature history capture error: ${err?.message || err}`));
        }, this._sampleMs);
    }

    public stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = undefined;
        this._started = false;
    }

    public async read(start?: any, end?: any): Promise<TempHistoryPoint[]> {
        const from = this.parseTime(start, Date.now() - (24 * 60 * 60 * 1000));
        const to = this.parseTime(end, Date.now());
        if (!fs.existsSync(this._file)) return [];
        const lines = await fs.promises.readFile(this._file, "utf8");
        return lines.split(/\r?\n/)
            .filter(line => line.trim().length > 0)
            .map(line => this.parseLine(line))
            .filter(point => typeof point !== "undefined" && point.ts >= from && point.ts <= to);
    }

    public get latestDewPoint(): number {
        return this._latestDewPoint;
    }

    public onDewPointChange(handler: (dewPoint: number) => void) {
        this._dewPointChangeHandlers.push(handler);
    }

    private async capture() {
        await this.refreshDewPoint();
        const point = this.currentPoint();
        if (!this.hasAnyTemp(point)) return;
        await fs.promises.appendFile(this._file, JSON.stringify(point) + "\n", "utf8");
        await this.prune();
    }

    private currentPoint(): TempHistoryPoint {
        return {
            ts: Date.now(),
            pool: this.cleanTemp(state.temps.bodies.getItemById(1).temp),
            spa: this.cleanTemp(state.temps.bodies.getItemById(2).temp),
            glacier: this.cleanTemp(state.temps.solar),
            air: this.cleanTemp(state.temps.air),
            dewPoint: this.cleanTemp(this._latestDewPoint)
        };
    }

    private async refreshDewPoint() {
        const now = Date.now();
        if (now - this._lastDewPointFetch < this._dewPointFetchMs) return;
        const coords = this.getPoolCoordinates();
        if (typeof coords === "undefined") return;
        this._lastDewPointFetch = now;
        try {
            const dewPoint = await this.fetchOpenMeteoDewPoint(coords.latitude, coords.longitude);
            if (typeof dewPoint === "number") this.setLatestDewPoint(dewPoint);
        } catch (err) {
            logger.warn(`Dew point fetch error: ${err?.message || err}`);
        }
    }

    private setLatestDewPoint(dewPoint: number) {
        const changed = this._latestDewPoint !== dewPoint;
        this._latestDewPoint = dewPoint;
        if (!changed) return;
        this._dewPointChangeHandlers.forEach(handler => {
            try {
                handler(dewPoint);
            } catch (err) {
                logger.error(`Dew point change handler error: ${err?.message || err}`);
            }
        });
    }

    private getPoolCoordinates(): { latitude: number, longitude: number } | undefined {
        const loc = sys?.general?.location || {} as any;
        let latitude = this.cleanCoordinate(loc.latitude);
        let longitude = this.cleanCoordinate(loc.longitude);
        if (typeof latitude !== "number") latitude = this.cleanCoordinate(process.env.POOL_LATITUDE);
        if (typeof longitude !== "number") longitude = this.cleanCoordinate(process.env.POOL_LONGITUDE);
        if ((typeof latitude !== "number" || typeof longitude !== "number") && loc.zip) {
            const zipCoords = getCoordinatesForZip(loc.zip);
            if (zipCoords) {
                if (typeof latitude !== "number") latitude = zipCoords.latitude;
                if (typeof longitude !== "number") longitude = zipCoords.longitude;
            }
        }
        if (typeof latitude === "number" && typeof longitude === "number") return { latitude, longitude };
        return undefined;
    }

    private async fetchOpenMeteoDewPoint(latitude: number, longitude: number): Promise<number> {
        const url = new URL("https://api.open-meteo.com/v1/forecast");
        url.searchParams.set("latitude", String(latitude));
        url.searchParams.set("longitude", String(longitude));
        url.searchParams.set("current", "dew_point_2m");
        url.searchParams.set("temperature_unit", "fahrenheit");
        url.searchParams.set("timezone", "auto");
        const data = await this.fetchJson(url.toString());
        const dewPoint = Number(data?.current?.dew_point_2m);
        return isNaN(dewPoint) ? undefined : dewPoint;
    }

    private fetchJson(url: string): Promise<any> {
        return new Promise((resolve, reject) => {
            const req = https.get(url, { headers: { "User-Agent": "nodejs-poolController dew point history" } }, res => {
                let body = "";
                res.setEncoding("utf8");
                res.on("data", chunk => body += chunk);
                res.on("end", () => {
                    if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`HTTP ${res.statusCode}`));
                    try {
                        resolve(JSON.parse(body));
                    } catch (err) {
                        reject(err);
                    }
                });
            });
            req.setTimeout(10000, () => req.destroy(new Error("request timed out")));
            req.on("error", reject);
        });
    }

    private async prune() {
        if (!fs.existsSync(this._file)) return;
        const cutoff = Date.now() - this._retentionMs;
        const raw = await fs.promises.readFile(this._file, "utf8");
        const kept = raw.split(/\r?\n/)
            .filter(line => {
                if (line.trim().length === 0) return false;
                const point = this.parseLine(line);
                return point && point.ts >= cutoff;
            });
        await fs.promises.writeFile(this._file, kept.length > 0 ? kept.join("\n") + "\n" : "", "utf8");
    }

    private parseLine(line: string): TempHistoryPoint {
        try {
            const point = JSON.parse(line);
            if (typeof point.ts !== "number") return undefined;
            return point;
        } catch (err) {
            return undefined;
        }
    }

    private cleanTemp(value: any): number {
        const n = Number(value);
        return isNaN(n) || n <= -999 ? undefined : n;
    }

    private cleanCoordinate(value: any): number {
        const n = Number(value);
        return isNaN(n) ? undefined : n;
    }

    private hasAnyTemp(point: TempHistoryPoint): boolean {
        return typeof point.pool === "number" || typeof point.spa === "number" ||
            typeof point.glacier === "number" || typeof point.air === "number" ||
            typeof point.dewPoint === "number";
    }

    private parseTime(value: any, fallback: number): number {
        if (typeof value === "number" && !isNaN(value)) return value;
        if (typeof value === "string" && value.trim().length > 0) {
            const numeric = Number(value);
            if (!isNaN(numeric)) return numeric;
            const parsed = Date.parse(value);
            if (!isNaN(parsed)) return parsed;
        }
        return fallback;
    }

    private ensureDataDir() {
        const dir = path.dirname(this._file);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
}

export const tempHistory = new TempHistoryService();
