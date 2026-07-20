import * as fs from "fs";
import * as path from "path";
import { logger } from "../../../logger/Logger";

export interface RuleActionLogDetail {
    type: string;
    id?: number;
    name?: string;
    state?: boolean | string;
    status: "ran" | "skipped" | "scheduled" | "log" | "lifecycle" | "error";
    message?: string;
}

export interface RuleActionLogEvent {
    ts: number;
    groupId: string;
    groupName: string;
    ruleId: string;
    ruleName: string;
    state: "then" | "otherwise" | "started" | "stopped";
    reason: string;
    summary: string;
    actions: RuleActionLogDetail[];
}

class RuleActionLogService {
    private readonly _retentionMs = 30 * 24 * 60 * 60 * 1000;
    private readonly _file = path.join(process.cwd(), "data", "rule-actions.jsonl");

    public async append(event: RuleActionLogEvent) {
        this.ensureDataDir();
        await fs.promises.appendFile(this._file, JSON.stringify(event) + "\n", "utf8");
        await this.prune();
    }

    public async read(query: { start?: any, end?: any, limit?: any } = {}): Promise<RuleActionLogEvent[]> {
        const from = this.parseTime(query.start, 0);
        const to = this.parseTime(query.end, Date.now());
        const limit = this.parseLimit(query.limit, 100);
        if (!fs.existsSync(this._file)) return [];
        const raw = await fs.promises.readFile(this._file, "utf8");
        const events = raw.split(/\r?\n/)
            .filter(line => line.trim().length > 0)
            .map(line => this.parseLine(line))
            .filter(event => event && event.ts >= from && event.ts <= to)
            .sort((a, b) => b.ts - a.ts);
        return events.slice(0, limit);
    }

    private async prune() {
        if (!fs.existsSync(this._file)) return;
        const cutoff = Date.now() - this._retentionMs;
        const raw = await fs.promises.readFile(this._file, "utf8");
        const kept = raw.split(/\r?\n/)
            .filter(line => {
                if (line.trim().length === 0) return false;
                const event = this.parseLine(line);
                return event && event.ts >= cutoff;
            });
        await fs.promises.writeFile(this._file, kept.length > 0 ? kept.join("\n") + "\n" : "", "utf8");
    }

    private parseLine(line: string): RuleActionLogEvent {
        try {
            const event = JSON.parse(line);
            if (typeof event.ts !== "number") return undefined;
            if (!Array.isArray(event.actions)) event.actions = [];
            return event;
        } catch (err) {
            return undefined;
        }
    }

    private parseLimit(value: any, fallback: number): number {
        const limit = parseInt(value, 10);
        if (isNaN(limit)) return fallback;
        return Math.max(1, Math.min(1000, limit));
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

export const ruleActionLog = new RuleActionLogService();
