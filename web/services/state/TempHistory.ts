import * as fs from "fs";
import * as path from "path";
import { state } from "../../../controller/State";
import { logger } from "../../../logger/Logger";

export interface TempHistoryPoint {
    ts: number;
    pool?: number;
    spa?: number;
    glacier?: number;
    air?: number;
}

class TempHistoryService {
    private readonly _sampleMs = 5 * 60 * 1000;
    private readonly _retentionMs = 120 * 24 * 60 * 60 * 1000;
    private readonly _file = path.join(process.cwd(), "data", "temp-history.jsonl");
    private _timer: NodeJS.Timeout;
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

    private async capture() {
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
            air: this.cleanTemp(state.temps.air)
        };
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

    private hasAnyTemp(point: TempHistoryPoint): boolean {
        return typeof point.pool === "number" || typeof point.spa === "number" ||
            typeof point.glacier === "number" || typeof point.air === "number";
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
