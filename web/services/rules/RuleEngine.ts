import { config } from "../../../config/Config";
import { logger } from "../../../logger/Logger";
import { sys } from "../../../controller/Equipment";
import { state } from "../../../controller/State";
import { tempHistory } from "../state/TempHistory";
import { ruleActionLog, RuleActionLogDetail } from "./RuleActionLog";

type RuleOperator = '>' | '>=' | '<' | '<=' | '===' | '!==' | 'isTrue' | 'isFalse';
type ActionType = 'setCircuit' | 'setFeature' | 'setScheduleDisabled' | 'log' | 'circuitLock' | 'featureLock';

interface RuleCondition {
    left: string | number | boolean;
    operator: RuleOperator;
    right?: string | number | boolean;
}

interface RuleAction {
    type: ActionType;
    id?: number;
    ids?: number[];
    state?: boolean | string;
    message?: string;
    delaySeconds?: number;
}

interface RuleHysteresis {
    enabled: boolean;
    durationSeconds: number;
    resetOnFalse: boolean;
}

interface RuleActiveWindow {
    enabled: boolean;
    startDate?: string;
    endDate?: string;
    days?: number[];
    startTime?: string;
    endTime?: string;
}

interface RuleDefinition {
    id: string;
    name: string;
    enabled: boolean;
    match?: 'all' | 'any';
    conditions: RuleCondition[];
    actions: RuleAction[];
    otherwiseActions: RuleAction[];
    hysteresis?: RuleHysteresis;
    action?: 'on' | 'off';
}

interface RuleGroup {
    id: string;
    name: string;
    enabled: boolean;
    match?: 'all' | 'any';
    bodyId?: number;
    targetType?: 'circuit' | 'feature';
    targetId?: number;
    activeWindow?: RuleActiveWindow;
    vars: any;
    rules: RuleDefinition[];
}

interface RuleConfig {
    enabled: boolean;
    groups: RuleGroup[];
}

interface ScheduleDisableState {
    owners: string[];
}

interface RuleRuntimeState {
    scheduleDisables: { [id: string]: ScheduleDisableState };
}

class RuleEngine {
    private _timer: NodeJS.Timeout;
    private _isEvaluating = false;
    private _delayedActions = new Map<string, NodeJS.Timeout>();
    private _transitionTimers = new Map<string, NodeJS.Timeout>();
    private _ruleStableStates = new Map<string, boolean>();
    private readonly _events = ['temps', 'body', 'bodyTempState', 'circuit', 'feature', 'schedule', 'controller', 'weather'];

    public getConfig(): RuleConfig {
        return this.normalizeConfig(config.getSection('web.rules', { enabled: true, groups: [] }));
    }

    public setConfig(cfg: RuleConfig): RuleConfig {
        const rules = this.normalizeConfig(cfg);
        config.setSection('web.rules', rules);
        this.queueEvaluate('config');
        return this.getConfig();
    }

    public handleEvent(evt: string) {
        if (this._events.indexOf(evt) === -1) return;
        this.queueEvaluate(evt);
    }

    public async evaluateNow(reason = 'manual') {
        if (this._timer) clearTimeout(this._timer);
        await this.evaluate(reason);
        return this.getConfig();
    }

    public getStatus() {
        const cfg = this.getConfig();
        return {
            enabled: cfg.enabled,
            groups: cfg.groups.map(group => {
                const activeStatus = this.getGroupActiveStatus(group);
                return {
                    id: group.id,
                    enabled: group.enabled,
                    active: cfg.enabled && group.enabled && activeStatus.active,
                    inactiveReason: activeStatus.active ? undefined : activeStatus.reason,
                    rules: group.rules.map(rule => this.getRuleStatus(cfg.enabled, group, rule, activeStatus))
                };
            })
        };
    }

    private queueEvaluate(reason: string) {
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(() => {
            this.evaluate(reason).catch(err => logger.error(`Rule engine evaluation error: ${err?.message || err}`));
        }, 1000);
    }

    private normalizeConfig(cfg: any): RuleConfig {
        cfg = cfg || {};
        const groups = Array.isArray(cfg.groups) ? cfg.groups : [];
        return {
            enabled: this.makeBool(cfg.enabled, true),
            groups: groups.map((g, i) => this.normalizeGroup(g, i))
        };
    }

    private normalizeGroup(group: any, index: number): RuleGroup {
        group = group || {};
        const rules = Array.isArray(group.rules) ? group.rules : [];
        return {
            id: group.id || `rule-group-${index + 1}`,
            name: group.name || `Rule Group ${index + 1}`,
            enabled: this.makeBool(group.enabled, true),
            match: group.match === 'any' ? 'any' : 'all',
            bodyId: parseInt(group.bodyId, 10) || undefined,
            targetType: group.targetType === 'circuit' ? 'circuit' : group.targetType === 'feature' ? 'feature' : undefined,
            targetId: parseInt(group.targetId, 10) || undefined,
            activeWindow: this.normalizeActiveWindow(group.activeWindow),
            vars: group.vars || {},
            rules: rules.map((r, i) => this.normalizeRule(group, r, i))
        };
    }

    private normalizeRule(group: any, rule: any, index: number): RuleDefinition {
        rule = rule || {};
        let actions = Array.isArray(rule.actions) ? rule.actions : [];
        if (actions.length === 0 && rule.action && group.targetType && group.targetId) {
            actions = [{ type: group.targetType === 'feature' ? 'setFeature' : 'setCircuit', id: group.targetId, state: rule.action === 'on' }];
        }
        return {
            id: rule.id || `rule-${index + 1}`,
            name: rule.name || `Rule ${index + 1}`,
            enabled: this.makeBool(rule.enabled, true),
            match: rule.match === 'any' ? 'any' : group.match === 'any' ? 'any' : 'all',
            conditions: Array.isArray(rule.conditions) ? rule.conditions : [],
            actions: actions.map(a => this.normalizeAction(a)),
            otherwiseActions: Array.isArray(rule.otherwiseActions) ? rule.otherwiseActions.map(a => this.normalizeAction(a)) : [],
            hysteresis: this.normalizeHysteresis(rule.hysteresis),
            action: rule.action
        };
    }

    private normalizeAction(action: any): RuleAction {
        action = action || {};
        return {
            type: action.type || 'setCircuit',
            id: typeof action.id !== 'undefined' ? parseInt(action.id, 10) : undefined,
            ids: Array.isArray(action.ids) ? action.ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id)) : undefined,
            state: typeof action.state === 'undefined' ? true : action.state,
            message: action.message,
            delaySeconds: parseInt(action.delaySeconds, 10) || 0
        };
    }

    private normalizeHysteresis(hysteresis: any): RuleHysteresis {
        hysteresis = hysteresis || {};
        return {
            enabled: this.makeBool(hysteresis.enabled, false),
            durationSeconds: parseInt(hysteresis.durationSeconds, 10) || parseInt(hysteresis.duration, 10) || 0,
            resetOnFalse: this.makeBool(hysteresis.resetOnFalse, true)
        };
    }

    private normalizeActiveWindow(activeWindow: any): RuleActiveWindow {
        activeWindow = activeWindow || {};
        const days = Array.isArray(activeWindow.days)
            ? activeWindow.days.map(day => parseInt(day, 10)).filter(day => !isNaN(day) && day >= 0 && day <= 6)
            : undefined;
        return {
            enabled: this.makeBool(activeWindow.enabled, false),
            startDate: this.normalizeDateText(activeWindow.startDate),
            endDate: this.normalizeDateText(activeWindow.endDate),
            days,
            startTime: this.normalizeTimeText(activeWindow.startTime),
            endTime: this.normalizeTimeText(activeWindow.endTime)
        };
    }

    private async evaluate(reason: string) {
        if (this._isEvaluating) return;
        this._isEvaluating = true;
        try {
            const cfg = this.getConfig();
            if (!cfg.enabled) {
                this.cancelAllPending();
                return;
            }
            for (const group of cfg.groups) {
                if (!group.enabled) continue;
                if (!this.getGroupActiveStatus(group).active) {
                    this.cancelGroupPending(group.id);
                    continue;
                }
                await this.evaluateGroup(group, reason);
            }
        }
        finally {
            this._isEvaluating = false;
        }
    }

    private async evaluateGroup(group: RuleGroup, reason: string) {
        for (const rule of group.rules) {
            if (!rule.enabled) continue;
            const matched = this.conditionsMatch(group, rule);
            await this.evaluateRuleState(group, rule, matched, reason);
        }
    }

    private async evaluateRuleState(group: RuleGroup, rule: RuleDefinition, matched: boolean, reason: string) {
        const h = rule.hysteresis;
        const key = `${group.id}:${rule.id}`;
        if (h && h.enabled && h.durationSeconds > 0) {
            const stableState = this._ruleStableStates.get(key);
            const pending = this._transitionTimers.get(key);
            const pendingState = pending ? (pending as any).targetState : undefined;

            if (stableState === matched) {
                this.cancelTransition(key);
                if (this.actionsNeedRun(group, rule, matched)) {
                    await this.runActionsForState(group, rule, matched, reason);
                }
                return;
            }
            if (pending && pendingState === matched) return;
            this.cancelTransition(key);
            const timer = setTimeout(() => {
                this._transitionTimers.delete(key);
                const currentGroup = this.getConfig().groups.find(g => g.id === group.id);
                const currentRule = currentGroup?.rules.find(r => r.id === rule.id);
                if (!currentGroup || !currentGroup.enabled || !currentRule || !currentRule.enabled) return;
                if (!this.getGroupActiveStatus(currentGroup).active) return;
                if (this.conditionsMatch(currentGroup, currentRule) !== matched) return;
                this._ruleStableStates.set(key, matched);
                this.runActionsForState(currentGroup, currentRule, matched, reason)
                    .catch(err => logger.error(`Rule hysteresis action error: ${err?.message || err}`));
            }, h.durationSeconds * 1000);
            (timer as any).targetState = matched;
            (timer as any).startedAt = Date.now();
            (timer as any).durationSeconds = h.durationSeconds;
            this._transitionTimers.set(key, timer);
            return;
        }

        this.cancelTransition(key);
        this._ruleStableStates.set(key, matched);
        await this.runActionsForState(group, rule, matched, reason);
    }

    private async runActionsForState(group: RuleGroup, rule: RuleDefinition, matched: boolean, reason: string) {
        const details: RuleActionLogDetail[] = [];
        if (matched) {
            this.cancelDelayedActions(group, rule, 'otherwise:');
            for (let i = 0; i < rule.actions.length; i++) {
                details.push(...await this.scheduleOrRunAction(group, rule, rule.actions[i], `then:${i}`, reason, true));
            }
        }
        else {
            this.cancelDelayedActions(group, rule, 'then:');
            for (let i = 0; i < rule.otherwiseActions.length; i++) {
                details.push(...await this.scheduleOrRunAction(group, rule, rule.otherwiseActions[i], `otherwise:${i}`, reason, false));
            }
        }
        await this.logRuleActionEvent(group, rule, matched, reason, details);
    }

    private cancelTransition(key: string) {
        if (!this._transitionTimers.has(key)) return;
        clearTimeout(this._transitionTimers.get(key));
        this._transitionTimers.delete(key);
    }

    private cancelDelayedActions(group: RuleGroup, rule: RuleDefinition, actionPrefix: string) {
        const keyPrefix = `${group.id}:${rule.id}:${actionPrefix}`;
        for (const key of Array.from(this._delayedActions.keys())) {
            if (!key.startsWith(keyPrefix)) continue;
            clearTimeout(this._delayedActions.get(key));
            this._delayedActions.delete(key);
        }
    }

    private cancelGroupPending(groupId: string) {
        const keyPrefix = `${groupId}:`;
        for (const key of Array.from(this._transitionTimers.keys())) {
            if (!key.startsWith(keyPrefix)) continue;
            clearTimeout(this._transitionTimers.get(key));
            this._transitionTimers.delete(key);
        }
        for (const key of Array.from(this._delayedActions.keys())) {
            if (!key.startsWith(keyPrefix)) continue;
            clearTimeout(this._delayedActions.get(key));
            this._delayedActions.delete(key);
        }
        for (const key of Array.from(this._ruleStableStates.keys())) {
            if (key.startsWith(keyPrefix)) this._ruleStableStates.delete(key);
        }
    }

    private cancelAllPending() {
        for (const timer of this._transitionTimers.values()) clearTimeout(timer);
        this._transitionTimers.clear();
        for (const timer of this._delayedActions.values()) clearTimeout(timer);
        this._delayedActions.clear();
    }

    private async scheduleOrRunAction(group: RuleGroup, rule: RuleDefinition, action: RuleAction, actionIndex: string, reason: string, requiredMatch = true): Promise<RuleActionLogDetail[]> {
        const key = `${group.id}:${rule.id}:${actionIndex}`;
        const delaySeconds = Math.max(0, parseInt(action.delaySeconds as any, 10) || 0);
        if (delaySeconds > 0) {
            if (this._delayedActions.has(key)) return this.describeAction(action, 'scheduled', `Already scheduled for ${delaySeconds}s delay.`);
            const timer = setTimeout(() => {
                this._delayedActions.delete(key);
                if (!this.getRuleStillMatches(group.id, rule.id, requiredMatch)) return;
                this.runAction(group, rule, action, reason).catch(err => logger.error(`Rule delayed action error: ${err?.message || err}`));
            }, delaySeconds * 1000);
            this._delayedActions.set(key, timer);
            return this.describeAction(action, 'scheduled', `Scheduled for ${delaySeconds}s delay.`);
        }
        if (this._delayedActions.has(key)) {
            clearTimeout(this._delayedActions.get(key));
            this._delayedActions.delete(key);
        }
        return await this.runAction(group, rule, action, reason);
    }

    private getRuleStillMatches(groupId: string, ruleId: string, expectedMatch = true): boolean {
        const cfg = this.getConfig();
        if (!cfg.enabled) return false;
        const group = cfg.groups.find(g => g.id === groupId);
        if (!group || !group.enabled) return false;
        if (!this.getGroupActiveStatus(group).active) return false;
        const rule = group.rules.find(r => r.id === ruleId);
        return !!rule && rule.enabled && this.conditionsMatch(group, rule) === expectedMatch;
    }

    private async runAction(group: RuleGroup, rule: RuleDefinition, action: RuleAction, reason: string): Promise<RuleActionLogDetail[]> {
        const details: RuleActionLogDetail[] = [];
        const desired = this.resolveActionState(action);
        const ids = action.ids && action.ids.length > 0 ? action.ids : typeof action.id !== 'undefined' ? [action.id] : [];
        for (const id of ids) {
            if (!id || isNaN(id)) continue;
            if (action.type === 'setCircuit') {
                if (state.circuits.getItemById(id).isOn === desired) {
                    details.push(this.actionDetail(action, id, desired, 'skipped', 'Circuit already in requested state.'));
                    continue;
                }
                logger.info(`Rule "${rule.name}" setting circuit ${id} ${desired ? 'ON' : 'OFF'} (${reason})`);
                await sys.board.circuits.setCircuitStateAsync(id, desired);
                details.push(this.actionDetail(action, id, desired, 'ran'));
            }
            else if (action.type === 'setFeature') {
                if (state.features.getItemById(id).isOn === desired) {
                    details.push(this.actionDetail(action, id, desired, 'skipped', 'Feature already in requested state.'));
                    continue;
                }
                logger.info(`Rule "${rule.name}" setting feature ${id} ${desired ? 'ON' : 'OFF'} (${reason})`);
                await sys.board.features.setFeatureStateAsync(id, desired);
                details.push(this.actionDetail(action, id, desired, 'ran'));
            }
            else if (action.type === 'setScheduleDisabled') {
                const needed = this.actionNeedsRun(group, rule, action);
                await this.setScheduleDisabled(id, desired, group, rule, reason);
                details.push(this.actionDetail(action, id, desired, needed ? 'ran' : 'skipped', needed ? undefined : 'Schedule already in requested rule-owned state.'));
            }
            else if (action.type === 'circuitLock' || action.type === 'featureLock') {
                const needed = this.actionNeedsRun(group, rule, action);
                await this.setCircuitLockout(id, desired, rule.name, reason);
                details.push(this.actionDetail(action, id, desired, needed ? 'ran' : 'skipped', needed ? undefined : 'Circuit/feature lock already in requested state.'));
            }
        }
        if (action.type === 'log') {
            logger.info(`Rule "${rule.name}": ${action.message || 'log action'} (${reason})`);
            details.push({
                type: action.type,
                status: 'log',
                message: action.message || 'log action'
            });
        }
        return details;
    }

    private async logRuleActionEvent(group: RuleGroup, rule: RuleDefinition, matched: boolean, reason: string, details: RuleActionLogDetail[]) {
        const actions = matched ? rule.actions : rule.otherwiseActions;
        if (actions.length === 0) return;
        const stateName = matched ? 'then' : 'otherwise';
        try {
            await ruleActionLog.append({
                ts: Date.now(),
                groupId: group.id,
                groupName: group.name,
                ruleId: rule.id,
                ruleName: rule.name,
                state: stateName,
                reason,
                summary: `Rule ${matched ? 'matched' : 'did not match'}; ran ${stateName === 'then' ? 'Then' : 'Otherwise'} actions.`,
                actions: details
            });
        } catch (err) {
            logger.error(`Rule action log write error: ${err?.message || err}`);
        }
    }

    private describeAction(action: RuleAction, status: RuleActionLogDetail['status'], message?: string): RuleActionLogDetail[] {
        const desired = this.resolveActionState(action);
        const ids = action.ids && action.ids.length > 0 ? action.ids : typeof action.id !== 'undefined' ? [action.id] : [];
        if (ids.length === 0) return [{ type: action.type, status, state: desired, message }];
        return ids.filter(id => id && !isNaN(id)).map(id => this.actionDetail(action, id, desired, status, message));
    }

    private actionDetail(action: RuleAction, id: number, desired: boolean, status: RuleActionLogDetail['status'], message?: string): RuleActionLogDetail {
        return {
            type: action.type,
            id,
            name: this.actionTargetName(action, id),
            state: desired,
            status,
            message
        };
    }

    private actionTargetName(action: RuleAction, id: number): string {
        try {
            if (action.type === 'setCircuit' || action.type === 'circuitLock') return state.circuits.getInterfaceById(id).name || sys.circuits.getItemById(id).name;
            if (action.type === 'setFeature' || action.type === 'featureLock') return state.features.getItemById(id).name || sys.features.getItemById(id).name;
            if (action.type === 'setScheduleDisabled') {
                const ssched = state.schedules.getItemById(id) as any;
                const sched = sys.schedules.getItemById(id) as any;
                return ssched.scheduleName || ssched.name || sched.scheduleName || sched.name;
            }
        } catch (err) { }
        return undefined;
    }

    private actionsNeedRun(group: RuleGroup, rule: RuleDefinition, matched: boolean): boolean {
        const actions = matched ? rule.actions : rule.otherwiseActions;
        return actions.some(action => this.actionNeedsRun(group, rule, action));
    }

    private actionNeedsRun(group: RuleGroup, rule: RuleDefinition, action: RuleAction): boolean {
        if (action.type === 'log') return false;
        const desired = this.resolveActionState(action);
        const ids = action.ids && action.ids.length > 0 ? action.ids : typeof action.id !== 'undefined' ? [action.id] : [];
        return ids.some(id => {
            if (!id || isNaN(id)) return false;
            if (action.type === 'setCircuit') return state.circuits.getItemById(id).isOn !== desired;
            if (action.type === 'setFeature') return state.features.getItemById(id).isOn !== desired;
            if (action.type === 'setScheduleDisabled') {
                const sched = sys.schedules.getItemById(id);
                const owner = this.scheduleOwnerKey(group, rule);
                const entry = this.getScheduleDisableEntry(this.getRuntimeState(), id);
                return desired ? sched.disabled !== true || entry.owners.indexOf(owner) === -1 : entry.owners.indexOf(owner) !== -1;
            }
            if (action.type === 'circuitLock' || action.type === 'featureLock') {
                const cstate = state.circuits.getInterfaceById(id);
                return cstate.lockoutOn !== desired || cstate.lockoutOff !== desired;
            }
            return false;
        });
    }

    private async setCircuitLockout(id: number, locked: boolean, ruleName: string, reason: string) {
        const cstate = state.circuits.getInterfaceById(id);
        if (cstate.lockoutOn === locked && cstate.lockoutOff === locked) return;
        logger.info(`Rule "${ruleName}" ${locked ? 'locking' : 'unlocking'} circuit/feature ${id} (${reason})`);
        cstate.lockoutOn = locked;
        cstate.lockoutOff = locked;
        cstate.emitEquipmentChange();
    }

    private async setScheduleDisabled(id: number, disabled: boolean, group: RuleGroup, rule: RuleDefinition, reason: string) {
        const sched = sys.schedules.getItemById(id);
        const ssched = state.schedules.getItemById(id);
        const owner = this.scheduleOwnerKey(group, rule);
        const runtime = this.getRuntimeState();
        const entry = this.getScheduleDisableEntry(runtime, id);

        if (disabled) {
            if (sched.disabled === true && entry.owners.length === 0) {
                logger.info(`Rule "${rule.name}" leaving manually disabled schedule ${id} disabled without taking ownership (${reason})`);
                return;
            }
            if (entry.owners.indexOf(owner) === -1) entry.owners.push(owner);
            this.setScheduleDisableEntry(runtime, id, entry);
            this.setRuntimeState(runtime);
            if (sched.disabled === true && ssched.disabled === true) {
                await config.updateAsync();
                return;
            }
            logger.info(`Rule "${rule.name}" disabling schedule ${id} (${reason})`);
            sched.disabled = true;
            ssched.disabled = true;
            ssched.recalculate(true);
            ssched.emitEquipmentChange();
            await config.updateAsync();
            return;
        }

        const ownerIndex = entry.owners.indexOf(owner);
        if (ownerIndex === -1) {
            logger.info(`Rule "${rule.name}" will not enable schedule ${id}; it does not own the disable (${reason})`);
            return;
        }
        entry.owners.splice(ownerIndex, 1);
        this.setScheduleDisableEntry(runtime, id, entry);
        this.setRuntimeState(runtime);
        if (entry.owners.length > 0) {
            logger.info(`Rule "${rule.name}" released schedule ${id}, but other rules still own the disable (${reason})`);
            await config.updateAsync();
            return;
        }
        if (sched.disabled === false && ssched.disabled === false) {
            await config.updateAsync();
            return;
        }
        logger.info(`Rule "${rule.name}" enabling schedule ${id} (${reason})`);
        sched.disabled = false;
        ssched.disabled = false;
        ssched.recalculate(true);
        ssched.emitEquipmentChange();
        await config.updateAsync();
    }

    private scheduleOwnerKey(group: RuleGroup, rule: RuleDefinition): string {
        return `${group.id}:${rule.id}`;
    }

    private getRuntimeState(): RuleRuntimeState {
        const runtime = config.getSection('web.ruleState', { scheduleDisables: {} }) || {};
        return { scheduleDisables: runtime.scheduleDisables || {} };
    }

    private setRuntimeState(runtime: RuleRuntimeState) {
        config.setSection('web.ruleState', runtime);
    }

    private getScheduleDisableEntry(runtime: RuleRuntimeState, id: number): ScheduleDisableState {
        const key = String(id);
        const entry = runtime.scheduleDisables[key] || { owners: [] };
        return { owners: Array.isArray(entry.owners) ? entry.owners.slice() : [] };
    }

    private setScheduleDisableEntry(runtime: RuleRuntimeState, id: number, entry: ScheduleDisableState) {
        const key = String(id);
        const owners = Array.from(new Set(entry.owners || []));
        if (owners.length === 0) delete runtime.scheduleDisables[key];
        else runtime.scheduleDisables[key] = { owners };
    }

    private conditionsMatch(group: RuleGroup, rule: RuleDefinition): boolean {
        const conditions = rule.conditions;
        if (!conditions || conditions.length === 0) return true;
        const results = conditions.map(condition => this.evaluateCondition(group, condition).matched);
        return rule.match === 'any' ? results.some(r => r) : results.every(r => r);
    }

    private getRuleStatus(engineEnabled: boolean, group: RuleGroup, rule: RuleDefinition, activeStatus?: { active: boolean, reason?: string }) {
        activeStatus = activeStatus || this.getGroupActiveStatus(group);
        const key = `${group.id}:${rule.id}`;
        const conditions = (rule.conditions || []).map((condition, index) => {
            const result = this.evaluateCondition(group, condition);
            return {
                index,
                matched: result.matched,
                left: result.left,
                right: result.right,
                operator: condition.operator
            };
        });
        const matched = !rule.conditions || rule.conditions.length === 0
            ? true
            : rule.match === 'any' ? conditions.some(c => c.matched) : conditions.every(c => c.matched);
        const pending = this.getPendingTransitionStatus(key);
        return {
            id: rule.id,
            enabled: rule.enabled,
            active: engineEnabled && group.enabled && activeStatus.active && rule.enabled,
            inactiveReason: activeStatus.active ? undefined : activeStatus.reason,
            matched,
            stableState: this._ruleStableStates.get(key),
            pending,
            conditions
        };
    }

    private getGroupActiveStatus(group: RuleGroup): { active: boolean, reason?: string } {
        if (!group.enabled) return { active: false, reason: 'disabled' };
        const window = group.activeWindow;
        if (!window || window.enabled !== true) return { active: true };
        const now = new Date();
        if (!this.dateInActiveWindow(window, now)) return { active: false, reason: 'outsideDateRange' };
        if (!this.dayInActiveWindow(window, now)) return { active: false, reason: 'outsideDayOfWeek' };
        if (!this.timeInActiveWindow(window, now)) return { active: false, reason: 'outsideTimeWindow' };
        return { active: true };
    }

    private dateInActiveWindow(window: RuleActiveWindow, now: Date): boolean {
        const start = this.dateOrdinal(window.startDate);
        const end = this.dateOrdinal(window.endDate);
        if (typeof start === 'undefined' && typeof end === 'undefined') return true;
        const current = this.monthDayOrdinal(now.getMonth() + 1, now.getDate());
        if (typeof start !== 'undefined' && typeof end === 'undefined') return current >= start;
        if (typeof start === 'undefined' && typeof end !== 'undefined') return current <= end;
        return start <= end ? current >= start && current <= end : current >= start || current <= end;
    }

    private dayInActiveWindow(window: RuleActiveWindow, now: Date): boolean {
        if (!window.days || window.days.length === 0) return true;
        return window.days.indexOf(now.getDay()) >= 0;
    }

    private timeInActiveWindow(window: RuleActiveWindow, now: Date): boolean {
        const start = this.timeMinutes(window.startTime);
        const end = this.timeMinutes(window.endTime);
        if (typeof start === 'undefined' && typeof end === 'undefined') return true;
        const current = now.getHours() * 60 + now.getMinutes();
        if (typeof start !== 'undefined' && typeof end === 'undefined') return current >= start;
        if (typeof start === 'undefined' && typeof end !== 'undefined') return current <= end;
        return start <= end ? current >= start && current <= end : current >= start || current <= end;
    }

    private normalizeDateText(value: any): string {
        if (typeof value !== 'string') return undefined;
        const text = value.trim();
        if (!text) return undefined;
        const match = text.match(/^(?:\d{4}[-/])?(\d{1,2})[-/](\d{1,2})$/);
        if (!match) return undefined;
        const month = parseInt(match[1], 10);
        const day = parseInt(match[2], 10);
        if (isNaN(month) || isNaN(day) || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
        return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    private normalizeTimeText(value: any): string {
        if (typeof value !== 'string') return undefined;
        const text = value.trim();
        if (!text) return undefined;
        const match = text.match(/^(\d{1,2}):(\d{2})$/);
        if (!match) return undefined;
        const hours = parseInt(match[1], 10);
        const minutes = parseInt(match[2], 10);
        if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return undefined;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }

    private dateOrdinal(value: string): number {
        if (typeof value !== 'string') return undefined;
        const parts = value.split('-');
        if (parts.length !== 2) return undefined;
        return this.monthDayOrdinal(parseInt(parts[0], 10), parseInt(parts[1], 10));
    }

    private monthDayOrdinal(month: number, day: number): number {
        if (isNaN(month) || isNaN(day)) return undefined;
        return month * 100 + day;
    }

    private timeMinutes(value: string): number {
        if (typeof value !== 'string') return undefined;
        const parts = value.split(':');
        if (parts.length !== 2) return undefined;
        const hours = parseInt(parts[0], 10);
        const minutes = parseInt(parts[1], 10);
        if (isNaN(hours) || isNaN(minutes)) return undefined;
        return hours * 60 + minutes;
    }

    private getPendingTransitionStatus(key: string) {
        const timer = this._transitionTimers.get(key) as any;
        if (!timer) return undefined;
        const startedAt = parseInt(timer.startedAt, 10) || Date.now();
        const durationSeconds = parseInt(timer.durationSeconds, 10) || 0;
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
        return {
            targetState: timer.targetState === true,
            startedAt,
            durationSeconds,
            remainingSeconds: Math.max(0, durationSeconds - elapsedSeconds)
        };
    }

    private evaluateCondition(group: RuleGroup, condition: RuleCondition): { matched: boolean, left: any, right: any } {
        const left = this.resolveValue(group, condition.left);
        if (condition.operator === 'isTrue') return { matched: left === true, left, right: undefined };
        if (condition.operator === 'isFalse') return { matched: left === false, left, right: undefined };
        const right = this.resolveValue(group, condition.right);
        if (typeof left === 'undefined' || typeof right === 'undefined' || left === null || right === null) {
            return { matched: false, left, right };
        }
        return { matched: this.compare(left, condition.operator, right), left, right };
    }

    private resolveValue(group: RuleGroup, value: any): any {
        if (typeof value !== 'string') return value;
        if (typeof group.vars !== 'undefined' && typeof group.vars[value] !== 'undefined') return group.vars[value];
        if (value.indexOf('tempDelta:') === 0) return this.resolveTempDelta(group, value);
        const bodyId = group.bodyId || 1;
        const body = state.temps.bodies.getItemById(bodyId);
        switch (value) {
            case 'poolTemp': return state.temps.bodies.getItemById(1).temp;
            case 'spaTemp': return state.temps.bodies.getItemById(2).temp;
            case 'bodyTemp': return body.temp;
            case 'solarTemp': return this.showSolarTemp() ? state.temps.solar : undefined;
            case 'airTemp': return state.temps.air;
            case 'dewPoint': return tempHistory.latestDewPoint;
            case 'poolSolarDelta': return this.showSolarTemp() ? this.delta(state.temps.bodies.getItemById(1).temp, state.temps.solar) : undefined;
            case 'spaSolarDelta': return this.showSolarTemp() ? this.delta(state.temps.bodies.getItemById(2).temp, state.temps.solar) : undefined;
            case 'bodySolarDelta': return this.showSolarTemp() ? this.delta(body.temp, state.temps.solar) : undefined;
            case 'spaHeatModeOn': return state.temps.bodies.getItemById(2).heatMode > 0;
            case 'spaHeaterActive': return state.temps.bodies.getItemById(2).heatStatus > 0;
            case 'poolHeatModeOn': return state.temps.bodies.getItemById(1).heatMode > 0;
            case 'poolHeaterActive': return state.temps.bodies.getItemById(1).heatStatus > 0;
            default: return this.resolvePathValue(value);
        }
    }

    private resolveTempDelta(group: RuleGroup, value: string): number {
        const parts = value.split(':');
        if (parts.length !== 3) return undefined;
        return this.delta(this.resolveValue(group, parts[1]), this.resolveValue(group, parts[2]));
    }

    private resolvePathValue(value: string): any {
        const parts = value.split(':');
        if (parts.length !== 3) return value;
        const id = parseInt(parts[1], 10);
        if (isNaN(id)) return undefined;
        switch (`${parts[0]}:${parts[2]}`) {
            case 'circuit:isOn': return state.circuits.getItemById(id).isOn === true;
            case 'feature:isOn': return state.features.getItemById(id).isOn === true;
            case 'schedule:disabled': return state.schedules.getItemById(id).disabled === true;
            case 'schedule:isOn': return state.schedules.getItemById(id).isOn === true;
            default: return value;
        }
    }

    private delta(a: number, b: number): number {
        return typeof a === 'number' && typeof b === 'number' ? a - b : undefined;
    }

    private showSolarTemp(): boolean {
        return config.getSection('web.temperatureLabels.solar', { show: true }).show !== false;
    }

    private compare(left: any, operator: RuleOperator, right: any): boolean {
        switch (operator) {
            case '>': return left > right;
            case '>=': return left >= right;
            case '<': return left < right;
            case '<=': return left <= right;
            case '===': return left === right;
            case '!==': return left !== right;
            default: return false;
        }
    }

    private resolveActionState(action: RuleAction): boolean {
        if (typeof action.state === 'string') return this.makeBool(action.state);
        return this.makeBool(action.state);
    }

    private makeBool(value: any, defaultValue = false): boolean {
        if (typeof value === 'undefined') return defaultValue;
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'string') {
            switch (value.toLowerCase().trim()) {
                case 'true':
                case 'yes':
                case 'y':
                case 'on':
                case '1':
                    return true;
                case 'false':
                case 'no':
                case 'n':
                case 'off':
                case '0':
                case '':
                    return false;
            }
        }
        return defaultValue;
    }
}

export const ruleEngine = new RuleEngine();
