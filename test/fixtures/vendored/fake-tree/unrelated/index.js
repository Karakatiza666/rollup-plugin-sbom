export class EventEmitter {
    constructor() {
        this.listenersByEvent = new Map();
    }

    on(event, listener) {
        const listeners = this.listenersByEvent.get(event) ?? [];
        listeners.push(listener);
        this.listenersByEvent.set(event, listeners);
        return () => this.off(event, listener);
    }

    off(event, listener) {
        const listeners = this.listenersByEvent.get(event);
        if (!listeners) {
            return;
        }
        const index = listeners.indexOf(listener);
        if (index >= 0) {
            listeners.splice(index, 1);
        }
        if (listeners.length === 0) {
            this.listenersByEvent.delete(event);
        }
    }

    emit(event, ...args) {
        for (const listener of [...(this.listenersByEvent.get(event) ?? [])]) {
            listener(...args);
        }
    }
}

export function debounce(callback, waitMs) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => callback(...args), waitMs);
    };
}

export function throttle(callback, intervalMs) {
    let lastCallTime = -Infinity;
    let pendingArgs;
    let timer;
    const invoke = () => {
        lastCallTime = Date.now();
        timer = undefined;
        callback(...pendingArgs);
    };
    return (...args) => {
        pendingArgs = args;
        const elapsed = Date.now() - lastCallTime;
        if (elapsed >= intervalMs) {
            invoke();
        } else if (timer === undefined) {
            timer = setTimeout(invoke, intervalMs - elapsed);
        }
    };
}
