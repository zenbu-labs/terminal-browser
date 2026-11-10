import type { EngineKeyEvent } from "../react";
import type { Guest } from "./server";



export interface ShellTab {
  key: string;
  guest: Guest | null;
  label: string;
}

export class Shell {
  private guests: Guest[] = [];
  private activeIndex = 0;
  private restoreFocus: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();
  private snapshot: { tabs: ShellTab[]; active: number } | null = null;

  constructor(private readonly ownerLabel: () => string) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get = () => {
    if (!this.snapshot) {
      this.snapshot = {
        tabs: [
          { key: "owner", guest: null, label: this.ownerLabel() },
          ...this.guests.map((guest) => ({
            key: guest.pane,
            guest,
            label: guest.title || guest.name,
          })),
        ],
        active: this.activeIndex,
      };
    }
    return this.snapshot;
  };

  get active(): number {
    return this.activeIndex;
  }

  guestActive(): boolean {
    return this.activeIndex > 0;
  }

  hasGuests(): boolean {
    return this.guests.length > 0;
  }

  activeGuest(): Guest | null {
    return this.guests[this.activeIndex - 1] ?? null;
  }

  add(guest: Guest) {
    this.guests.push(guest);
    guest.onTitle = () => this.changed();
    this.activate(this.guests.length);
  }

  remove(guest: Guest) {
    const at = this.guests.indexOf(guest);
    if (at < 0) return;
    this.guests.splice(at, 1);
    const wasActive = this.activeIndex === at + 1;
    if (this.activeIndex > this.guests.length) this.activeIndex = this.guests.length;
    if (wasActive && this.activeIndex === 0) this.restoreFocus?.();
    this.changed();
  }

  onCloseOwner: (() => void) | null = null;

  close(index: number) {
    if (index === 0) this.onCloseOwner?.();
    else this.guests[index - 1]?.close();
  }

  successor(): Guest | null {
    return this.activeGuest() ?? this.guests[0] ?? null;
  }

  others(except: Guest): Guest[] {
    return this.guests.filter((guest) => guest !== except);
  }

  activate(index: number) {
    const clamped = Math.max(0, Math.min(index, this.guests.length));
    if (clamped === this.activeIndex) return;
    this.activeIndex = clamped;
    if (clamped === 0) this.restoreFocus?.();
    this.changed();
  }

  rememberFocus(restore: () => void) {
    this.restoreFocus = restore;
  }

  changed() {
    this.snapshot = null;
    for (const listener of this.listeners) listener();
  }

  handleKey(event: EngineKeyEvent): boolean {
    if (!this.hasGuests() || event.kind === "release") return false;
    const { mods, key } = event;
    if (!mods.alt || mods.ctrl || mods.super || mods.shift) return false;
    if (/^[1-9]$/.test(key)) {
      this.activate(Number(key) - 1);
      return true;
    }
    if (key === "[" || key === "]") {
      const count = this.guests.length + 1;
      this.activate((this.activeIndex + (key === "]" ? 1 : count - 1)) % count);
      return true;
    }
    return false;
  }
}
