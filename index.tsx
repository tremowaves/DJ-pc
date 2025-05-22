/**
 * @fileoverview Control real time music with a MIDI controller
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { css, html, LitElement, svg, CSSResultGroup, nothing } from 'lit';
import { customElement, property, query, state } from 'lit/decorators';
import { styleMap } from 'lit/directives/style-map';
import { classMap } from 'lit/directives/class-map';
import { repeat } from 'lit/directives/repeat';

import { GoogleGenAI, type LiveMusicSession, type LiveMusicServerMessage } from '@google/genai';
import { decode, decodeAudioData } from './utils'

// Use process.env.API_KEY and remove apiVersion as per guidelines
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
const model = 'lyria-realtime-exp';


interface Prompt {
  readonly promptId: string;
  text: string;
  weight: number;
  cc: number;
  color: string;
}

interface StoredPromptConfig {
  text: string;
  weight: number;
  cc: number;
  color: string;
  promptId: string; // Keep original promptId for consistent mapping
}

interface Preset {
  id: string;
  name: string;
  description?: string;
  category: string;
  prompts: StoredPromptConfig[];
  createdAt: number;
  updatedAt: number;
}

interface ControlChange {
  channel: number;
  cc: number;
  value: number;
}

type PlaybackState = 'stopped' | 'playing' | 'loading' | 'paused';
type RecordingState = 'idle' | 'recording' | 'recorded_available';

/**
 * Throttles a callback to be called at most once per `delay` milliseconds.
 * Also returns the result of the last "fresh" call...
 */
function throttle<T extends (...args: Parameters<T>) => ReturnType<T>>(
  func: T,
  delay: number,
): (...args: Parameters<T>) => ReturnType<T> {
  let lastCall = -Infinity;
  let lastResult: ReturnType<T>;
  return (...args: Parameters<T>) => {
    const now = Date.now();
    const timeSinceLastCall = now - lastCall;
    if (timeSinceLastCall >= delay) {
      lastResult = func(...args);
      lastCall = now;
    }
    return lastResult;
  };
}

const DEFAULT_PROMPTS_CONFIG = [ // Renamed from DEFAULT_PROMPTS to avoid conflict
  { color: '#d8ff3e', text: 'ambient chillout D Minor scale 78 BPM - glass percussion, ethereal pads, celesta - structure: sparse intro (8 bars), verse (24 bars), climax (16 bars), gentle outro (16 bars)' },
  { color: '#3effa0', text: 'ambient chillout D Minor scale 78 BPM - glass percussion, ethereal pads, celesta - structure: sparse intro (8 bars), verse (24 bars), climax (16 bars), gentle outro (16 bars) - effects: reverb' },
  { color: '#3ed8ff', text: 'ambient chillout D Minor scale 78 BPM - glass percussion, ethereal pads, celesta - structure: sparse intro (8 bars), verse (24 bars), climax (16 bars), gentle outro (16 bars) - effects: delay' },
  { color: '#623eff', text: 'ambient chillout D Minor scale 78 BPM - glass percussion, ethereal pads, celesta - structure: sparse intro (8 bars), verse (24 bars), climax (16 bars), gentle outro (16 bars) - focus: high frequencies' },
  { color: '#d83eff', text: 'ambient chillout D Minor scale 78 BPM - glass percussion, ethereal pads, celesta - structure: sparse intro (8 bars), verse (24 bars), climax (16 bars), gentle outro (16 bars) - focus: mid frequencies' },
  { color: '#ff3e90', text: 'ambient chillout D Minor scale 78 BPM - glass percussion, ethereal pads, celesta - structure: sparse intro (8 bars), verse (24 bars), climax (16 bars), gentle outro (16 bars) - focus: low frequencies' },
  { color: '#ff8c3e', text: 'ambient chillout D Minor scale 78 BPM - glass percussion, ethereal pads, celesta - structure: sparse intro (8 bars), verse (24 bars), climax (16 bars), gentle outro (16 bars) - volume: fade in/out' },
  { color: '#ffe03e', text: 'ambient chillout D Minor scale 78 BPM - glass percussion, ethereal pads, celesta - structure: sparse intro (8 bars), verse (24 bars), climax (16 bars), gentle outro (16 bars) - filter cutoff' },
];

const PRESET_STORAGE_KEY = 'promptDjMidiPresets';
const DEFAULT_CATEGORY = "User Saved";

// Preset Management Utilities
// -----------------------------------------------------------------------------
function getStoredPresets(): Preset[] {
  const stored = localStorage.getItem(PRESET_STORAGE_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        // Basic validation for preset structure
        return parsed.filter(p => p && p.id && p.name && Array.isArray(p.prompts));
      }
    } catch (e) {
      console.error("Failed to parse stored presets:", e);
      localStorage.removeItem(PRESET_STORAGE_KEY);
    }
  }
  return [];
}

function savePresetsToStorage(presets: Preset[]): void {
  try {
    localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
  } catch (e) {
    console.error("Failed to save presets to localStorage:", e);
    // Potentially notify user if storage is full
  }
}


// Toast Message component
// -----------------------------------------------------------------------------

@customElement('toast-message')
class ToastMessage extends LitElement {
  static override styles = css`
    .toast {
      line-height: 1.6;
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background-color: #000;
      color: white;
      padding: 15px;
      border-radius: 5px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 15px;
      min-width: 200px;
      max-width: 80vw;
      transition: transform 0.5s cubic-bezier(0.19, 1, 0.22, 1), opacity 0.5s ease-out;
      z-index: 10000; /* Ensure toast is above preset browser */
      opacity: 0;
      pointer-events: none;
    }
    button {
      border-radius: 100px;
      aspect-ratio: 1;
      border: none;
      color: #000;
      background-color: #fff;
      cursor: pointer;
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
    }
    .toast.showing {
      opacity: 1;
      transform: translate(-50%, 0);
      pointer-events: auto;
    }
    .toast:not(.showing).hiding {
      transition-duration: 1s;
      transform: translate(-50%, -200%);
      opacity: 0;
    }
  `;

  @property({ type: String }) message = '';
  @state() private _showing = false;
  private hideTimeout: number | undefined;

  override render() {
    return html`<div class=${classMap({ showing: this._showing, toast: true, hiding: !this._showing && this.message !== '' })}>
      <div class="message">${this.message}</div>
      <button @click=${this.hide} aria-label="Close message">✕</button>
    </div>`;
  }

  show(message: string, duration: number = 3000) {
    this.message = message;
    this._showing = true;
    clearTimeout(this.hideTimeout);
    if (duration > 0) {
      this.hideTimeout = window.setTimeout(() => this.hide(), duration);
    }
  }

  hide() {
    this._showing = false;
  }
}

// WeightSlider component (Vertical Slider)
// -----------------------------------------------------------------------------
const SLIDER_MIN_HALO_SCALE = 0.8;
const SLIDER_MAX_HALO_SCALE = 1.5;
const SLIDER_HALO_LEVEL_MODIFIER = 0.5;

@customElement('weight-slider')
class WeightSlider extends LitElement {
  static override styles = css`
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      width: 30px; /* Width of the slider track area */
      height: 100px; /* Default height, can be overridden by parent */
      cursor: grab;
      position: relative;
      touch-action: none; /* Prevent scrolling on touch devices */
      -webkit-tap-highlight-color: transparent; /* Remove tap highlight on mobile */
    }

    #slider-container {
      position: relative;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    #track {
      width: 8px;
      height: 100%;
      background-color: rgba(255, 255, 255, 0.2); /* Lighter track for dark bg */
      border-radius: 4px;
      position: relative;
      overflow: hidden; /* Ensure fill stays within track bounds */
    }

    #fill {
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      background-color: var(--slider-color, #fff);
      border-radius: 4px; /* Apply to top corners if needed, or match track */
    }

    #thumb {
      width: 20px;
      height: 20px;
      background-color: #fff;
      border: 2px solid rgba(0,0,0,0.3);
      border-radius: 50%;
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      box-shadow: 0 1px 3px rgba(0,0,0,0.3);
      z-index: 1; /* Ensure thumb is above fill */
    }

    #halo {
      position: absolute;
      left: 50%;
      bottom: var(--thumb-bottom-percent, 0%);
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: var(--slider-color, #fff);
      mix-blend-mode: lighten;
      transform: translate(-50%, 50%) scale(1); /* Initial: center horizontally, align halo's top with thumb's bottom */
      pointer-events: none;
      z-index: -1;
      will-change: transform, opacity;
      transition: transform 0.1s ease-out, opacity 0.1s ease-out;
    }
  `;

  @property({ type: Number }) value = 0; // 0 to 2
  @property({ type: String }) color = '#000';
  @property({ type: Number }) audioLevel = 0;

  @query('#slider-container') private sliderContainer!: HTMLDivElement;
  @query('#track') private trackElement!: HTMLDivElement;
  @query('#thumb') private thumbElement!: HTMLDivElement;
  @query('#halo') private haloElement!: HTMLDivElement;

  private dragStartPos = 0;
  private dragStartValue = 0;
  private isDragging = false;

  constructor() {
    super();
    this.handlePointerDown = this.handlePointerDown.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handlePointerUp = this.handlePointerUp.bind(this);
  }

  private calculateValueFromY(clientY: number, trackRect: DOMRect): number {
    const trackHeight = trackRect.height;
    if (trackHeight === 0) return 0; // Avoid division by zero
    let relativeY = clientY - trackRect.top;
    let proportion = (trackHeight - relativeY) / trackHeight;
    proportion = Math.max(0, Math.min(1, proportion));
    return proportion * 2;
  }

  private updateValue(newValue: number) {
    const clampedValue = Math.max(0, Math.min(2, newValue));
    if (this.value !== clampedValue) {
      this.value = clampedValue;
      this.dispatchEvent(new CustomEvent<number>('input', { detail: this.value }));
    }
  }

  private handlePointerDown(e: PointerEvent) {
    if (e.button !== 0) return;
    
    this.sliderContainer.setPointerCapture(e.pointerId);

    const trackRect = this.trackElement.getBoundingClientRect();
    const clickedValue = this.calculateValueFromY(e.clientY, trackRect);
    this.updateValue(clickedValue);

    this.dragStartPos = e.clientY;
    this.dragStartValue = this.value;
    this.isDragging = true;
    
    document.body.classList.add('dragging');
    this.style.cursor = 'grabbing';

    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    
    e.preventDefault();
  }

  private handlePointerMove(e: PointerEvent) {
    if (!this.isDragging) return;
    
    const trackRect = this.trackElement.getBoundingClientRect();
    if (trackRect.height === 0) return;

    const deltaY = this.dragStartPos - e.clientY;
    const valueChange = (deltaY / trackRect.height) * 2;
    const newValue = this.dragStartValue + valueChange;
    this.updateValue(newValue);
    
    e.preventDefault();
  }

  private handlePointerUp(e: PointerEvent) {
    if (!this.isDragging) return;
    this.isDragging = false;
    
    this.sliderContainer.releasePointerCapture(e.pointerId);
    
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    
    document.body.classList.remove('dragging');
    this.style.cursor = 'grab';
  }

  private handleWheel(e: WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY;
    let newValue = this.value - delta * 0.0025 * 2; // Adjusted sensitivity
    this.updateValue(newValue);
  }

  override render() {
    const fillHeightPercent = (this.value / 2) * 100;
    const thumbPositionPercent = Math.max(0, Math.min(100, fillHeightPercent)); 

    const fillStyle = styleMap({
      height: `${fillHeightPercent}%`,
    });

    const thumbHeight = this.thumbElement?.offsetHeight || 20;
    const thumbStyle = styleMap({
      bottom: `calc(${thumbPositionPercent}% - ${thumbHeight / 2}px)`,
    });

    let haloScale = (this.value / 2) * (SLIDER_MAX_HALO_SCALE - SLIDER_MIN_HALO_SCALE);
    haloScale += SLIDER_MIN_HALO_SCALE;
    haloScale += this.audioLevel * SLIDER_HALO_LEVEL_MODIFIER;
    const haloOpacity = this.value > 0 ? 0.7 : 0;

    const haloStyle = styleMap({
      transform: `translate(-50%, 50%) scale(${haloScale})`,
      opacity: `${haloOpacity}`,
    });
    
    this.style.setProperty('--slider-color', this.color);
    this.style.setProperty('--thumb-bottom-percent', `${thumbPositionPercent}%`);

    return html`
      <div id="slider-container"
           @pointerdown=${this.handlePointerDown}
           @wheel=${this.handleWheel}
           role="slider"
           tabindex="0"
           aria-valuemin="0"
           aria-valuemax="2"
           aria-valuenow=${this.value}
           aria-orientation="vertical"
           aria-label="Weight control slider">
        <div id="track">
          <div id="fill" style=${fillStyle}></div>
        </div>
        <div id="thumb" style=${thumbStyle}></div>
        <div id="halo" style=${haloStyle}></div>
      </div>
    `;
  }
}


// Base class for icon buttons.
class IconButton extends LitElement {
  static override styles = css`
    :host {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none; /* Allow clicks to pass to .hitbox */
    }
    :host(:hover) svg .icon-interactive-element { /* Target specific parts for hover if needed */
      transform: scale(1.2);
    }
    svg {
      width: 100%;
      height: 100%;
    }
    .icon-interactive-element {
       transition: transform 0.5s cubic-bezier(0.25, 1.56, 0.32, 0.99);
    }
    .hitbox {
      pointer-events: all;
      position: absolute;
      width: 65%;
      aspect-ratio: 1;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      cursor: pointer;
    }
  ` as CSSResultGroup;

  protected renderIcon() {
    return svg``;
  }

  private renderSVG() {
    return html` <svg
      width="140"
      height="140"
      viewBox="0 0 140 140"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true">
      <rect
        x="22"
        y="22" 
        width="96"
        height="96"
        rx="48"
        fill="black"
        fill-opacity="0.05" />
      <rect
        x="23.5"
        y="23.5"
        width="93"
        height="93"
        rx="46.5"
        stroke="black"
        stroke-opacity="0.3"
        stroke-width="3" />
      <g filter="url(#filter0_ddi_1048_7373)">
        <rect
          x="25"
          y="25" 
          width="90"
          height="90"
          rx="45"
          fill="white"
          fill-opacity="0.05"
          shape-rendering="crispEdges" />
      </g>
      ${this.renderIcon()}
      <defs>
        <filter
          id="filter0_ddi_1048_7373"
          x="0"
          y="0" 
          width="140"
          height="140"
          filterUnits="userSpaceOnUse"
          color-interpolation-filters="sRGB">
          <feFlood flood-opacity="0" result="BackgroundImageFix" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="2" />
          <feGaussianBlur stdDeviation="4" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend
            mode="normal"
            in2="BackgroundImageFix"
            result="effect1_dropShadow_1048_7373" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="16" />
          <feGaussianBlur stdDeviation="12.5" />
          <feComposite in2="hardAlpha" operator="out" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" />
          <feBlend
            mode="normal"
            in2="effect1_dropShadow_1048_7373"
            result="effect2_dropShadow_1048_7373" />
          <feBlend
            mode="normal"
            in="SourceGraphic"
            in2="effect2_dropShadow_1048_7373"
            result="shape" />
          <feColorMatrix
            in="SourceAlpha"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
            result="hardAlpha" />
          <feOffset dy="3" />
          <feGaussianBlur stdDeviation="1.5" />
          <feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.05 0" />
          <feBlend
            mode="normal"
            in2="shape"
            result="effect3_innerShadow_1048_7373" />
        </filter>
      </defs>
    </svg>`;
  }

  override render() {
    return html`${this.renderSVG()}<div class="hitbox" role="button" tabindex="0"></div>`;
  }
}

// PlayPauseButton
// -----------------------------------------------------------------------------

@customElement('play-pause-button')
export class PlayPauseButton extends IconButton {
  @property({ type: String }) playbackState: PlaybackState = 'stopped';

  static override styles = [
    IconButton.styles,
    css`
      .loader {
        stroke: #ffffff;
        stroke-width: 3;
        stroke-linecap: round;
        animation: spin linear 1s infinite;
        transform-origin: center;
        transform-box: fill-box;
      }
      @keyframes spin {
        from { transform: rotate(0deg) translateZ(0); } 
        to { transform: rotate(359deg) translateZ(0); }
      }
      .icon-path {
        transform-origin: 70px 70px; 
      }
    `
  ]

  private renderPause() {
    return svg`<g class="icon-interactive-element icon-path">
      <path
        d="M61 55 V85 H69 V55 H61 Z M71 55 V85 H79 V55 H71 Z"
        fill="#FEFEFE"
      />
    </g>`;
  }

  private renderPlay() {
    return svg`<g class="icon-interactive-element icon-path">
      <path d="M58 55 V85 L86 70 L58 55 Z" fill="#FEFEFE" />
    </g>`;
  }

  private renderLoading() {
    return svg`<g class="icon-interactive-element icon-path">
      <path class="loader" d="M 70 50 A 20 20 0 1 1 50 70" fill="none" />
    </g>`;
  }

  override renderIcon() {
    let icon;
    let label = "Play";
    if (this.playbackState === 'playing') {
      icon = this.renderPause();
      label = "Pause";
    } else if (this.playbackState === 'loading') {
      icon = this.renderLoading();
      label = "Loading";
    } else {
      icon = this.renderPlay();
      label = (this.playbackState === 'paused') ? "Resume" : "Play";
    }
    const hitbox = this.shadowRoot?.querySelector('.hitbox');
    if (hitbox) {
      hitbox.setAttribute('aria-label', label);
    }
    return icon;
  }
}

/** Simple class for dispatching MIDI CC messages as events. */
class MidiDispatcher extends EventTarget {
  private access: MIDIAccess | null = null;
  activeMidiInputId: string | null = null;

  async getMidiAccess(): Promise<string[]> {
    if (this.access && this.access.inputs.size > 0) {
      if (this.activeMidiInputId && !this.access.inputs.has(this.activeMidiInputId)) {
        this.activeMidiInputId = this.access.inputs.values().next().value?.id || null;
      }
      return Array.from(this.access.inputs.keys());
    }
    
    if (!navigator.requestMIDIAccess) {
      console.warn('Web MIDI API not supported in this browser.');
      return [];
    }

    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (error) {
      console.error('Failed to get MIDI access.', error);
      this.access = null;
      return [];
    }

    if (!this.access || this.access.inputs.size === 0) {
      console.warn('MIDI access granted but no inputs found.');
      return [];
    }
    
    this.access.onstatechange = (event: MIDIConnectionEvent) => {
        console.log('MIDI state change:', event.port.name, event.port.state);
        this.dispatchEvent(new CustomEvent('midistatechange'));
    };

    const inputIds = Array.from(this.access.inputs.keys());

    if (inputIds.length > 0 && this.activeMidiInputId === null) {
      this.activeMidiInputId = inputIds[0];
    }

    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (event: MIDIMessageEvent) => {
        if (input.id !== this.activeMidiInputId) return;

        const { data } = event;
        if (!data || data.length < 3) {
          return;
        }

        const statusByte = data[0];
        const channel = statusByte & 0x0f;
        const messageType = statusByte & 0xf0;

        const isControlChange = messageType === 0xb0; 
        if (!isControlChange) return;

        const detail: ControlChange = { cc: data[1], value: data[2], channel };
        this.dispatchEvent(
          new CustomEvent<ControlChange>('cc-message', { detail }),
        );
      };
    }

    return inputIds;
  }

  getDeviceName(id: string): string | null {
    if (!this.access) {
      return null;
    }
    const input = this.access.inputs.get(id);
    return input ? input.name : null;
  }
}

/** Simple class for getting the current level from our audio element. */
class AudioAnalyser {
  readonly node: AnalyserNode;
  private readonly freqData: Uint8Array;
  constructor(context: AudioContext) {
    this.node = context.createAnalyser();
    this.node.fftSize = 256; 
    this.node.smoothingTimeConstant = 0.3; 
    this.freqData = new Uint8Array(this.node.frequencyBinCount);
  }
  getCurrentLevel() {
    this.node.getByteFrequencyData(this.freqData);
    const avg = this.freqData.reduce((a, b) => a + b, 0) / this.freqData.length;
    return avg / 0xff; 
  }
}

/** A single prompt input associated with a MIDI CC. */
@customElement('prompt-controller')
class PromptController extends LitElement {
  static override styles = css`
    .prompt {
      width: 100%;
      height: 100%; /* Ensure prompt controller takes full cell height */
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-around; /* Distribute space for slider, text, cc */
      position: relative; 
      padding: 0.5vmin; /* Add some padding */
      box-sizing: border-box;
    }
    weight-slider {
      height: 10vmin; /* Or a percentage like 60% of cell height */
      min-height: 50px; /* Ensure slider is usable */
      flex-shrink: 0; /* Prevent shrinking if space is tight */
      margin-bottom: 0.5vmin; /* Space between slider and text */
    }
    #midi {
      font-family: monospace;
      text-align: center;
      font-size: 1.5vmin;
      border: 0.2vmin solid #fff;
      border-radius: 0.5vmin;
      padding: 2px 5px;
      color: #fff;
      background: #0006;
      cursor: pointer;
      visibility: hidden;
      user-select: none;
      margin-top: 0.5vmin; /* Adjusted margin */
      .learn-mode & {
        color: orange;
        border-color: orange;
      }
      .show-cc & {
        visibility: visible;
      }
    }
    #text {
      font-family: 'Google Sans', sans-serif; 
      font-weight: 500;
      font-size: 1.8vmin;
      max-width: 90%; /* Max width to prevent overflow from cell */
      min-width: 2vmin; 
      padding: 0.1em 0.3em;
      flex-shrink: 1; /* Allow text to shrink if needed */
      min-height: 2.2em; /* Ensure space for two lines if wrapped, adjust as needed */
      max-height: 4.4em; /* Limit height to prevent excessive growth */
      overflow-y: auto; /* Scroll if text exceeds max-height */
      border-radius: 0.25vmin;
      text-align: center;
      white-space: pre-wrap; 
      word-break: break-word;
      border: none;
      outline: none;
      -webkit-font-smoothing: antialiased;
      background: #000;
      color: #fff;
      line-height: 1.2; 
      &:focus {
        outline: 1px solid #fff; 
        overflow: visible; 
      }
    }
    :host([filtered="true"]) #text { 
      background: #da2000;
    }
    :host([filtered="true"])::after { 
        content: "⚠️";
        position: absolute;
        top: 0.2vmin;
        right: 0.2vmin;
        font-size: 1.5vmin;
        padding: 0.2vmin;
        background-color: #da2000;
        color: white;
        border-radius: 50%;
    }
    @media only screen and (max-width: 600px) {
      #text { 
        font-size: 2.3vmin;
      }
      weight-slider {
        height: 9vmin; /* Slightly smaller slider on mobile */
      }
    }
  `;

  @property({ type: String }) promptId = '';
  @property({ type: String }) text = '';
  @property({ type: Number }) weight = 0;
  @property({ type: String }) color = '';

  @property({ type: Number }) cc = 0;
  @property({ type: Number }) channel = 0; 

  @property({ type: Boolean, reflect: true }) learnMode = false; 
  @property({ type: Boolean, reflect: true }) showCC = false; 
  @property({ type: Boolean, reflect: true }) filtered = false;


  @query('weight-slider') private weightInput!: WeightSlider;
  @query('#text') private textInput!: HTMLInputElement;

  @property({ type: Object })
  midiDispatcher: MidiDispatcher | null = null;

  @property({ type: Number }) audioLevel = 0;

  private lastValidText!: string;

  private ccMessageHandler = (e: Event) => {
    const customEvent = e as CustomEvent<ControlChange>;
    const { channel, cc, value } = customEvent.detail;
    if (this.learnMode) {
      this.cc = cc;
      this.channel = channel; 
      this.learnMode = false; 
      this.dispatchPromptChange();
    } else if (cc === this.cc) { // Make sure channel matches if you want to be specific
      this.weight = (value / 127) * 2;
      this.dispatchPromptChange();
    }
  };

  override connectedCallback() {
    super.connectedCallback();
    this.midiDispatcher?.addEventListener('cc-message', this.ccMessageHandler);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.midiDispatcher?.removeEventListener('cc-message', this.ccMessageHandler);
  }


  override firstUpdated() {
    this.textInput.setAttribute('contenteditable', 'plaintext-only');
    this.textInput.textContent = this.text;
    this.lastValidText = this.text;

    this.textInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.textInput.blur();
      } else if (e.key === 'Escape') {
        this.textInput.textContent = this.lastValidText; 
        this.textInput.blur();
      }
    });
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    super.updated(changedProperties);
    if (changedProperties.has('showCC') && !this.showCC) {
      this.learnMode = false; 
    }
    if (changedProperties.has('text') && this.textInput && this.textInput.textContent !== this.text) {
      this.textInput.textContent = this.text; 
      this.lastValidText = this.text;
    }
    if (changedProperties.has('filtered')) {
       this.requestUpdate(); 
    }
    if (changedProperties.has('weight') && this.weightInput) {
        this.weightInput.value = this.weight; // Ensure slider reflects external changes
    }
  }


  private dispatchPromptChange() {
    this.dispatchEvent(
      new CustomEvent<Prompt>('prompt-changed', {
        detail: {
          promptId: this.promptId,
          text: this.text,
          weight: this.weight,
          cc: this.cc,
          color: this.color,
        },
        bubbles: true, 
        composed: true,
      }),
    );
  }

  private async updateText() {
    const newText = this.textInput.textContent?.trim() ?? '';
    if (!newText) { 
      this.textInput.textContent = this.lastValidText;
    } else if (newText !== this.text) { 
      this.text = newText;
      this.lastValidText = newText;
      this.dispatchPromptChange();
    }
  }

  private onFocus() {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(this.textInput);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  private updateWeight(event: CustomEvent<number>) { 
    const newWeight = event.detail;
    if (newWeight !== this.weight) {
      this.weight = newWeight;
      this.dispatchPromptChange();
    }
  }

  private toggleLearnMode(e: Event) {
    e.stopPropagation(); 
    this.learnMode = !this.learnMode;
  }

  override render() {
    const classes = classMap({
      'prompt': true,
      'learn-mode': this.learnMode,
      'show-cc': this.showCC,
    });
    const midiButtonLabel = this.learnMode ? `Learning MIDI CC for ${this.text}. Send a CC message.` : `MIDI CC: ${this.cc}. Click to learn new CC.`;
    return html`<div class=${classes}>
      <weight-slider
        id="weight"
        .value=${this.weight}
        .color=${this.color}
        .audioLevel=${this.audioLevel}
        @input=${this.updateWeight} 
        aria-label="Adjust weight for prompt ${this.text}"></weight-slider>
      <span
        id="text"
        role="textbox"
        aria-multiline="true"
        spellcheck="false"
        @focus=${this.onFocus}
        @blur=${this.updateText}
        aria-label="Prompt text for ${this.text}, current value: ${this.text}"
      ></span>
      <button 
        id="midi" 
        @click=${this.toggleLearnMode} 
        aria-pressed=${this.learnMode}
        aria-label=${midiButtonLabel}
        title=${midiButtonLabel}
      >
        ${this.learnMode ? 'Learn...' : `CC:${this.cc}`}
      </button>
    </div>`;
  }
}

// SavePresetModal Component
// -----------------------------------------------------------------------------
@customElement('save-preset-modal')
class SavePresetModal extends LitElement {
  static override styles = css`
    :host {
      display: block;
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(0,0,0,0.7);
      z-index: 1001; /* Above main UI, below toast */
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .modal-content {
      background-color: #222;
      padding: 25px;
      border-radius: 8px;
      width: 90%;
      max-width: 500px;
      box-shadow: 0 5px 15px rgba(0,0,0,0.3);
      color: #fff;
    }
    h2 {
      margin-top: 0;
      color: #eee;
    }
    label {
      display: block;
      margin-top: 15px;
      margin-bottom: 5px;
      font-weight: 500;
    }
    input[type="text"], textarea, select {
      width: calc(100% - 20px);
      padding: 10px;
      border-radius: 4px;
      border: 1px solid #555;
      background-color: #333;
      color: #fff;
      font-size: 1em;
    }
    textarea {
      min-height: 60px;
      resize: vertical;
    }
    .actions {
      margin-top: 25px;
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }
    button {
      padding: 10px 18px;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      font-weight: 600;
    }
    .save-button {
      background-color: #4CAF50;
      color: white;
    }
    .save-button:hover {
      background-color: #45a049;
    }
    .cancel-button {
      background-color: #777;
      color: white;
    }
    .cancel-button:hover {
      background-color: #666;
    }
  `;

  @property({ type: String }) presetName = '';
  @property({ type: String }) presetDescription = '';
  @property({ type: String }) presetCategory = DEFAULT_CATEGORY;
  @property({ type: Array }) existingCategories: string[] = [DEFAULT_CATEGORY];
  @property({ type: Boolean }) isEditing = false;


  private handleSubmit(e: Event) {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const nameInput = form.elements.namedItem('presetName') as HTMLInputElement;
    const descriptionInput = form.elements.namedItem('presetDescription') as HTMLTextAreaElement;
    const categorySelect = form.elements.namedItem('presetCategory') as HTMLSelectElement;
    const newCategoryInput = form.elements.namedItem('newCategory') as HTMLInputElement;

    let category = categorySelect.value;
    if (category === '_new_' && newCategoryInput.value.trim()) {
        category = newCategoryInput.value.trim();
        if (!this.existingCategories.includes(category) && category !== DEFAULT_CATEGORY) {
            // If it's a truly new category, we might want to add it to the select for next time
            // This is handled by PromptDjMidi re-calculating categories
        }
    } else if (category === '_new_') { // New category selected but input is empty
        category = DEFAULT_CATEGORY; // Fallback if new category is empty
    }
    
    this.dispatchEvent(new CustomEvent('save-preset-details', {
      detail: {
        name: nameInput.value.trim(),
        description: descriptionInput.value.trim(),
        category: category,
      },
      bubbles: true,
      composed: true,
    }));
  }

  private handleCancel() {
    this.dispatchEvent(new CustomEvent('cancel-save-preset', { bubbles: true, composed: true }));
  }
  
  private onCategoryChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    const newCategoryRow = this.shadowRoot?.getElementById('newCategoryRow') as HTMLDivElement;
    if (select.value === '_new_') {
        newCategoryRow.style.display = 'block';
        const newCategoryInput = this.shadowRoot?.getElementById('newCategory') as HTMLInputElement;
        if(newCategoryInput) newCategoryInput.focus();
    } else {
        newCategoryRow.style.display = 'none';
    }
  }

  override updated(changedProperties: Map<string | number | symbol, unknown>) {
    if (changedProperties.has('isEditing') || changedProperties.has('existingCategories') || changedProperties.has('presetCategory')) {
      // Ensure the newCategoryRow visibility is correct when properties change externally
      const newCategoryRow = this.shadowRoot?.getElementById('newCategoryRow') as HTMLDivElement;
      const categorySelect = this.shadowRoot?.getElementById('presetCategory') as HTMLSelectElement;
      if (categorySelect && newCategoryRow) {
        const uniqueCategories = [...new Set([DEFAULT_CATEGORY, ...this.existingCategories])];
        if (categorySelect.value === '_new_' || (!uniqueCategories.includes(this.presetCategory) && this.presetCategory)) {
            newCategoryRow.style.display = 'block';
        } else {
            newCategoryRow.style.display = 'none';
        }
      }
    }
  }

  override render() {
    const uniqueCategories = [...new Set([DEFAULT_CATEGORY, ...this.existingCategories.filter(c => c)])].sort();
    
    let displayNewCategoryRow = this.presetCategory === '_new_';
    if (!uniqueCategories.includes(this.presetCategory) && this.presetCategory !== DEFAULT_CATEGORY && this.isEditing) {
        // If editing a preset with a category not in the standard list (e.g. imported), show new category input.
        displayNewCategoryRow = true;
    }
    // Ensure category select defaults correctly if presetCategory is not in uniqueCategories
    const selectedCategoryValue = uniqueCategories.includes(this.presetCategory) ? this.presetCategory : (displayNewCategoryRow ? '_new_' : DEFAULT_CATEGORY);


    return html`
      <div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="save-preset-title">
        <h2 id="save-preset-title">${this.isEditing ? 'Edit' : 'Save'} Preset</h2>
        <form @submit=${this.handleSubmit}>
          <div>
            <label for="presetName">Preset Name</label>
            <input type="text" id="presetName" name="presetName" .value=${this.presetName} required>
          </div>
          <div>
            <label for="presetDescription">Description (Optional)</label>
            <textarea id="presetDescription" name="presetDescription" .value=${this.presetDescription}></textarea>
          </div>
          <div>
            <label for="presetCategory">Category</label>
            <select id="presetCategory" name="presetCategory" .value=${selectedCategoryValue} @change=${this.onCategoryChange}>
              ${uniqueCategories.map(cat => html`<option value=${cat} ?selected=${cat === this.presetCategory}>${cat}</option>`)}
              <option value="_new_">Create new category...</option>
            </select>
          </div>
          <div id="newCategoryRow" style="display: ${displayNewCategoryRow ? 'block' : 'none' }">
            <label for="newCategory">New Category Name</label>
            <input type="text" id="newCategory" name="newCategory" .value=${(displayNewCategoryRow && selectedCategoryValue === '_new_' && !uniqueCategories.includes(this.presetCategory) && this.presetCategory) ? this.presetCategory : ''}>
          </div>
          <div class="actions">
            <button type="button" @click=${this.handleCancel} class="cancel-button">Cancel</button>
            <button type="submit" class="save-button">${this.isEditing ? 'Save Changes' : 'Save Preset'}</button>
          </div>
        </form>
      </div>
    `;
  }
}

// PresetBrowserView Component
// -----------------------------------------------------------------------------
@customElement('preset-browser-view')
class PresetBrowserView extends LitElement {
  static override styles = css`
    :host {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background-color: rgba(10, 10, 10, 0.95);
      z-index: 1000; /* Below toast, above most UI */
      display: flex;
      flex-direction: column;
      color: #fff;
      font-family: 'Google Sans', sans-serif;
      overflow: hidden;
    }
    .browser-header {
      padding: 15px 20px;
      background-color: #1a1a1a;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid #333;
    }
    .browser-header h2 {
      margin: 0;
      font-size: 1.5em;
    }
    .close-browser-btn {
      background: none;
      border: none;
      color: #fff;
      font-size: 1.8em;
      cursor: pointer;
      padding: 5px;
    }
    .browser-content {
      display: flex;
      flex-grow: 1;
      overflow: hidden;
    }
    .categories-panel {
      width: 200px;
      background-color: #1f1f1f;
      padding: 15px;
      border-right: 1px solid #333;
      overflow-y: auto;
      flex-shrink: 0;
    }
    .categories-panel h3 {
      margin-top: 0;
      font-size: 1.1em;
      color: #ccc;
    }
    .category-list button {
      display: block;
      width: 100%;
      padding: 10px;
      margin-bottom: 5px;
      background: none;
      border: 1px solid transparent;
      color: #ddd;
      text-align: left;
      cursor: pointer;
      border-radius: 4px;
      font-size: 0.95em;
    }
    .category-list button:hover {
      background-color: #333;
    }
    .category-list button.active {
      background-color: #007bff;
      color: white;
      font-weight: bold;
    }
    .presets-panel {
      flex-grow: 1;
      padding: 15px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }
    .presets-toolbar {
      display: flex;
      gap: 10px;
      margin-bottom: 15px;
      align-items: center;
      flex-wrap: wrap;
    }
    .presets-toolbar input[type="search"] {
      padding: 8px 12px;
      border-radius: 4px;
      border: 1px solid #444;
      background-color: #2a2a2a;
      color: #fff;
      flex-grow: 1;
      font-size: 0.9em;
      min-width: 150px;
    }
    .presets-toolbar button, .file-input-label {
      padding: 8px 12px;
      border-radius: 4px;
      border: none;
      background-color: #007bff;
      color: white;
      cursor: pointer;
      font-size: 0.9em;
      white-space: nowrap;
    }
    .presets-toolbar button:hover, .file-input-label:hover {
      background-color: #0056b3;
    }
    .preset-list {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .preset-item {
      background-color: #2c2c2c;
      border: 1px solid #444;
      border-radius: 4px;
      padding: 15px;
      margin-bottom: 10px;
      display: flex;
      flex-direction: column; /* Stack info and actions on small screens */
      gap: 10px;
    }
    @media (min-width: 600px) {
      .preset-item {
        flex-direction: row;
        justify-content: space-between;
        align-items: center;
      }
    }
    .preset-info {
      flex-grow: 1;
    }
    .preset-info h4 {
      margin: 0 0 5px 0;
      font-size: 1.1em;
    }
    .preset-info p {
      margin: 0;
      font-size: 0.85em;
      color: #bbb;
    }
    .preset-info .meta-text {
      font-size: 0.75em; color: #888; margin-top: 5px;
    }
    .preset-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap; /* Allow actions to wrap */
      flex-shrink: 0;
    }
    .preset-actions button {
      padding: 6px 10px;
      font-size: 0.85em;
      border-radius: 3px;
      border: none;
      cursor: pointer;
    }
    .load-btn { background-color: #28a745; color: white; }
    .edit-btn { background-color: #ffc107; color: black; }
    .duplicate-btn { background-color: #17a2b8; color: white; }
    .delete-btn { background-color: #dc3545; color: white; }

    .no-presets {
      text-align: center;
      color: #888;
      margin-top: 30px;
    }

    .file-input-label {
      background-color: #6c757d;
    }
    .file-input-label:hover {
      background-color: #5a6268;
    }
    input[type="file"] {
      display: none;
    }
  `;

  @property({ type: Array }) presets: Preset[] = [];
  @state() private selectedCategory: string | null = "All Presets";
  @state() private searchTerm = "";

  private get categories() {
    const cats = new Set<string>(this.presets.map(p => p.category || DEFAULT_CATEGORY));
    return ["All Presets", ...Array.from(cats).sort()];
  }

  private get filteredPresets() {
    return this.presets
      .filter(p => 
        (this.selectedCategory === "All Presets" || (p.category || DEFAULT_CATEGORY) === this.selectedCategory) &&
        (p.name.toLowerCase().includes(this.searchTerm.toLowerCase()) || 
         (p.description || '').toLowerCase().includes(this.searchTerm.toLowerCase()))
      )
      .sort((a,b) => b.updatedAt - a.updatedAt);
  }

  private handleClose() {
    this.dispatchEvent(new CustomEvent('close-preset-browser', { bubbles: true, composed: true }));
  }

  private handleLoad(presetId: string) {
    this.dispatchEvent(new CustomEvent('load-preset', { detail: presetId, bubbles: true, composed: true }));
    // Do not close browser here, let PromptDjMidi decide or user close manually
  }
  
  private handleEdit(presetId: string) {
    this.dispatchEvent(new CustomEvent('edit-preset-request', { detail: presetId, bubbles: true, composed: true }));
    // Do not close browser here
  }

  private handleDuplicate(presetId: string) {
    // Confirmation is good, but can be handled by PromptDjMidi if more complex logic needed
    this.dispatchEvent(new CustomEvent('duplicate-preset', { detail: presetId, bubbles: true, composed: true }));
  }

  private handleDelete(presetId: string) {
    const preset = this.presets.find(p => p.id === presetId);
    if (confirm(`Are you sure you want to delete preset "${preset?.name}"? This cannot be undone.`)) {
      this.dispatchEvent(new CustomEvent('delete-preset', { detail: presetId, bubbles: true, composed: true }));
    }
  }
  
  private handleImport(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const importedPresets = JSON.parse(e.target?.result as string);
          // Add more robust validation for preset structure if needed
          if (Array.isArray(importedPresets) && importedPresets.every(p => p.id && p.name && Array.isArray(p.prompts))) {
             this.dispatchEvent(new CustomEvent('import-presets', { detail: importedPresets, bubbles: true, composed: true }));
          } else {
            alert("Invalid preset file format. Ensure it's an array of presets with id, name, and prompts.");
          }
        } catch (err) {
          alert("Error reading preset file: " + (err as Error).message);
        }
        input.value = ''; // Reset file input
      };
      reader.readAsText(input.files[0]);
    }
  }

  private handleExport() {
    this.dispatchEvent(new CustomEvent('export-presets', {bubbles: true, composed: true}));
  }

  override render() {
    const displayedPresets = this.filteredPresets;

    return html`
      <div class="browser-header">
        <h2>Preset Browser</h2>
        <button @click=${this.handleClose} class="close-browser-btn" aria-label="Close preset browser">&times;</button>
      </div>
      <div class="browser-content">
        <div class="categories-panel">
          <h3>Categories</h3>
          <div class="category-list">
            ${this.categories.map(cat => html`
              <button 
                class=${classMap({ active: this.selectedCategory === cat })}
                @click=${() => { this.selectedCategory = cat; }}
                aria-pressed=${this.selectedCategory === cat}
              >${cat}</button>
            `)}
          </div>
        </div>
        <div class="presets-panel">
          <div class="presets-toolbar">
            <input 
              type="search" 
              placeholder="Search presets..."
              .value=${this.searchTerm}
              @input=${(e: Event) => this.searchTerm = (e.target as HTMLInputElement).value}
              aria-label="Search presets"
            >
            <label for="import-presets-input" class="file-input-label" role="button" tabindex="0">Import</label>
            <input type="file" id="import-presets-input" @change=${this.handleImport} accept=".json" aria-hidden="true">
            <button @click=${this.handleExport}>Export All</button>
          </div>
          ${displayedPresets.length > 0 ? html`
            <ul class="preset-list">
              ${repeat(displayedPresets, p => p.id, p => html`
                <li class="preset-item">
                  <div class="preset-info">
                    <h4>${p.name}</h4>
                    <p>${p.description || 'No description'}</p>
                    <p class="meta-text">Category: ${p.category || DEFAULT_CATEGORY} | Updated: ${new Date(p.updatedAt).toLocaleDateString()}</p>
                  </div>
                  <div class="preset-actions">
                    <button @click=${() => this.handleLoad(p.id)} class="load-btn" title="Load preset">Load</button>
                    <button @click=${() => this.handleEdit(p.id)} class="edit-btn" title="Edit preset">Edit</button>
                    <button @click=${() => this.handleDuplicate(p.id)} class="duplicate-btn" title="Duplicate preset">Duplicate</button>
                    <button @click=${() => this.handleDelete(p.id)} class="delete-btn" title="Delete preset">Delete</button>
                  </div>
                </li>
              `)}
            </ul>
          ` : html`<p class="no-presets">No presets found${this.searchTerm ? ' for your search term' : (this.selectedCategory === "All Presets" ? "." : " in this category.")}</p>`}
        </div>
      </div>
    `;
  }
}


/** The grid of prompt inputs. */
@customElement('prompt-dj-midi')
class PromptDjMidi extends LitElement {
  static override styles = css`
    :host {
      height: 100%;
      width: 100%; 
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      box-sizing: border-box;
      position: relative;
      overflow: hidden; 
    }
    #background {
      will-change: background-image; 
      position: absolute;
      height: 100%;
      width: 100%;
      z-index: -1;
      background: #111; 
      transition: background-image 0.1s ease-out; 
    }
    #grid {
      width: 80vmin;
      height: 80vmin;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      grid-auto-rows: 1fr; 
      gap: 2.5vmin;
      margin-top: max(8vmin, 80px); /* Increased top margin for header */
      padding-bottom: 2vmin; 
      z-index: 1; 
    }
    prompt-controller { 
      width: 100%;
      height: 100%; 
    }
    .main-controls-container {
      display: flex;
      align-items: center;
      gap: 20px; /* Space between play/pause and record button */
      margin-top: 3vmin;
      z-index: 1;
    }
    play-pause-button {
      position: relative; 
      width: clamp(100px, 15vmin, 140px); 
      height: clamp(100px, 15vmin, 140px);
    }
    #record-button {
      width: clamp(60px, 10vmin, 80px);
      height: clamp(60px, 10vmin, 80px);
      border-radius: 50%;
      background-color: #fff;
      border: 3px solid rgba(0,0,0,0.3);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 2px 5px rgba(0,0,0,0.2);
      transition: background-color 0.2s, transform 0.2s;
      color: #333; /* Icon color */
    }
    #record-button svg {
      width: 50%;
      height: 50%;
      fill: currentColor;
    }
    #record-button.recording {
      background-color: #ff4136; /* Red when recording */
      color: #fff;
      animation: pulse 1.5s infinite;
    }
    #record-button.recorded_available {
        background-color: #007bff; /* Blue when recorded file available */
        color: #fff;
    }
    #record-button:hover:not(:disabled) {
        transform: scale(1.05);
    }
    #record-button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(255, 65, 54, 0.7); }
      70% { box-shadow: 0 0 0 10px rgba(255, 65, 54, 0); }
      100% { box-shadow: 0 0 0 0 rgba(255, 65, 54, 0); }
    }
    #controls-header {
      position: absolute;
      top: 10px;
      left: 10px;
      right: 10px; 
      padding: 5px;
      display: flex;
      gap: 10px; 
      align-items: center;
      z-index: 10; 
      flex-wrap: wrap; 
    }
    /* Common style for header buttons and select */
    .header-control { 
      font-family: 'Google Sans', sans-serif;
      font-weight: 600;
      cursor: pointer;
      color: #fff;
      background: rgba(0,0,0,0.4); 
      -webkit-font-smoothing: antialiased;
      border: 1.5px solid #fff;
      border-radius: 4px;
      user-select: none;
      padding: 6px 12px; 
      font-size: 0.9rem;
      transition: background-color 0.2s, color 0.2s;
    }
    .header-control:hover:not(:disabled) {
        background-color: rgba(255,255,255,0.8);
        color: #000;
    }
    .header-control.active {
        background-color: #fff;
        color: #000;
    }
     #controls-header select.header-control { /* Select specific styling */
      background: #fff; 
      color: #000;
      padding: 8px 10px; /* Slightly different padding for select might be needed */
    }
    .header-control:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    @media only screen and (max-width: 768px) {
      #grid {
        width: 90vmin;
        height: 90vmin;
        gap: 2vmin;
        margin-top: max(12vmin, 100px); /* Adjusted for header */
      }
       play-pause-button {
         width: clamp(80px, 18vmin, 120px);
         height: clamp(80px, 18vmin, 120px);
       }
       #record-button {
        width: clamp(50px, 9vmin, 70px);
        height: clamp(50px, 9vmin, 70px);
       }
    }
     @media only screen and (max-width: 480px) {
        #controls-header {
            justify-content: center; 
            gap: 5px;
        }
        .header-control {
            padding: 5px 8px;
            font-size: 0.8rem;
        }
        #grid {
            grid-template-columns: repeat(2, 1fr); 
            width: 95vmin;
            height: auto; 
            max-height: calc(95vmin * 2); 
            overflow-y: auto; 
            margin-top: max(15vmin, 120px); /* Adjusted for header */
        }
        prompt-controller {
            min-height: 18vmin; 
        }
     }
  `;

  @state() private prompts: Map<string, Prompt>;
  private midiDispatcher: MidiDispatcher;
  private audioAnalyser!: AudioAnalyser; 

  @state() private playbackState: PlaybackState = 'stopped';
  @state() private recordingState: RecordingState = 'idle';
  @state() private lastRecordingUrl: string | null = null;
  private lastRecordingMimeType: string = 'audio/webm';


  private session: LiveMusicSession | null = null; 
  private audioContext!: AudioContext; 
  private outputNode!: GainNode; 
  private recordingStreamDestination: MediaStreamAudioDestinationNode | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private recordedChunks: Blob[] = [];

  private nextStartTime = 0;
  private readonly bufferTime = 1; 

  @state() private showMidi = false;
  @state() private audioLevel = 0;
  @state() private midiInputIds: string[] = [];
  @state() private activeMidiInputId: string | null = null;
  @state() private isMidiSupported = !!navigator.requestMIDIAccess;
  private isMediaRecorderSupported = typeof MediaRecorder !== 'undefined';

  @state() private filteredPrompts = new Set<string>();
  private audioLevelRafId: number | null = null;
  @state() private connectionError = false; 

  @state() private isPresetBrowserOpen = false;
  @state() private userPresets: Preset[] = [];
  @state() private isSavePresetModalOpen = false;
  @state() private editingPreset: Preset | null = null; // For editing existing preset

  @query('play-pause-button') private playPauseButton!: PlayPauseButton;
  @query('toast-message') private toastMessage!: ToastMessage;
  @query('save-preset-modal') private savePresetModalElement!: SavePresetModal;


  constructor(
    initialPrompts: Map<string, Prompt>,
    midiDispatcher: MidiDispatcher,
  ) {
    super();
    this.prompts = initialPrompts;
    this.midiDispatcher = midiDispatcher;
    
    this.initAudio(); 
    if (this.audioAnalyser && this.audioAnalyser.node && this.outputNode) {
        this.outputNode.connect(this.audioAnalyser.node);
    }

    this.updateAudioLevel = this.updateAudioLevel.bind(this);
    this.updateAudioLevel();

    this.midiDispatcher.addEventListener('midistatechange', async () => {
        await this.refreshMidiDeviceList();
    });
    this.loadUserPresets();
  }

  private initAudio() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
        const AudioContextConstructor = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioContextConstructor) {
            console.error("Web Audio API is not supported in this browser.");
            this.playbackState = 'stopped'; 
            this.toastMessage?.show("Web Audio API not supported. Music playback disabled.", 5000);
            return;
        }
        this.audioContext = new AudioContextConstructor({ sampleRate: 48000 });
        this.outputNode = this.audioContext.createGain();
        this.outputNode.connect(this.audioContext.destination); 
        
        this.audioAnalyser = new AudioAnalyser(this.audioContext);
        // this.audioAnalyser.node.connect(this.audioContext.destination); // Connect analyser to destination if you want to hear its input
        this.outputNode.connect(this.audioAnalyser.node); // Analyse the output of Lyria

        if (this.isMediaRecorderSupported) {
            this.recordingStreamDestination = this.audioContext.createMediaStreamDestination();
            this.outputNode.connect(this.recordingStreamDestination); // Record what's going to speakers
        } else {
            console.warn("MediaRecorder API not available. Recording will be disabled.");
        }

    } else if (this.audioAnalyser && this.audioAnalyser.node.context !== this.audioContext) {
        this.audioAnalyser = new AudioAnalyser(this.audioContext);
        // this.audioAnalyser.node.connect(this.audioContext.destination);
        if (this.outputNode) {
          this.outputNode.connect(this.audioAnalyser.node);
          if(this.recordingStreamDestination) this.outputNode.connect(this.recordingStreamDestination);
        }
    }
  }

  override async firstUpdated() {
    await this.connectToSession(); 
    await this.setSessionPrompts(); 
    if (this.isMidiSupported) {
        await this.refreshMidiDeviceList();
    }
  }

  private async connectToSession() {
    if (this.session) { 
        try {
            this.session.close();
        } catch (e) {
            console.warn("Error closing previous session", e);
        }
        this.session = null;
    }

    this.playbackState = 'loading'; 
    this.connectionError = false;
    try {
      this.session = await ai.live.music.connect({
        model: model,
        callbacks: {
          onmessage: async (message: LiveMusicServerMessage) => {
            const msg = message; // No need to cast typically
            if (msg.error) {
              console.error('Session error:', msg.error);
              this.connectionError = true;
              this.playbackState = 'stopped';
              this.toastMessage.show(`Session Error: ${msg.error.message || 'Unknown error'}`, 5000);
              if (this.recordingState === 'recording') this.stopRecording();
              return;
            }

            if (msg.prompts?.rejected?.length) {
              const rejectedPromptIds = new Set<string>();
              for (const rejected of msg.prompts.rejected) {
                rejectedPromptIds.add(rejected.promptId);
              }
              this.filteredPrompts = rejectedPromptIds;
              this.toastMessage.show(
                'Some prompts were filtered due to safety policies.', 5000,
              );
            } else {
              this.filteredPrompts = new Set();
            }

            if (msg.state) {
              if (msg.state.type === 'buffering') {
                this.playbackState = 'loading';
              } else if (msg.state.type === 'playing') {
                this.playbackState = 'playing';
              } else if (msg.state.type === 'stopped') {
                this.stopMusic(true); // Lyria session stopped itself
              } else if (msg.state.type === 'paused') {
                // Handle if Lyria pauses itself, though we control pause mostly
                if (this.playbackState === 'playing') this.playbackState = 'paused';
              }
            }
            
            if (msg.status === 'finished') {
               this.stopMusic(false /* don't reset start time */);
            }

            if (msg.audio) {
              const audio = msg.audio;
              const data = decode(audio.data as string);
              const buffer = await decodeAudioData(
                data,
                this.audioContext,
                audio.sampleRateHz,
                audio.numChannels,
              );
              const source = this.audioContext.createBufferSource();
              source.buffer = buffer;
              source.connect(this.outputNode);
              
              const currentTime = this.audioContext.currentTime;
              if (this.nextStartTime < currentTime) {
                this.nextStartTime = currentTime;
              }
              source.start(this.nextStartTime);
              this.nextStartTime += buffer.duration;
            }
          },
          onclose: () => {
            console.log('Session closed.');
            this.playbackState = 'stopped';
            if (this.recordingState === 'recording') {
                this.stopRecording();
            }
          },
        },
      });
      this.playbackState = 'stopped'; // Ready to play after connection
    } catch (error) {
      console.error('Failed to connect to Lyria session:', error);
      this.connectionError = true;
      this.playbackState = 'stopped';
      this.toastMessage.show(`Connection failed: ${(error as Error).message}`, 5000);
      if (this.recordingState === 'recording') this.stopRecording();
    }
  }

  private async setSessionPrompts() {
    if (!this.session || this.connectionError) {
      console.warn('Session not available or connection error, cannot set prompts.');
      return;
    }
    const activePrompts = Array.from(this.prompts.values()).map((p) => ({
      id: p.promptId,
      text: p.text,
      weight: p.weight,
    }));
    
    try {
      await this.session.setPrompts(activePrompts);
    } catch (error) {
      console.error('Failed to set prompts:', error);
      this.toastMessage.show(`Error setting prompts: ${(error as Error).message}`, 4000);
    }
  }

  private updateAudioLevel() {
    if (this.audioAnalyser) {
      this.audioLevel = this.audioAnalyser.getCurrentLevel();
    }
    this.audioLevelRafId = requestAnimationFrame(this.updateAudioLevel);
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.session?.close();
    this.audioContext?.close();
    if (this.audioLevelRafId) {
      cancelAnimationFrame(this.audioLevelRafId);
    }
    if (this.lastRecordingUrl) {
        URL.revokeObjectURL(this.lastRecordingUrl);
    }
  }

  private handlePlayPauseClick = async () => {
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    if (this.connectionError) {
      await this.connectToSession();
      await this.setSessionPrompts();
      if(this.connectionError) { // Still error after reconnect attempt
        this.toastMessage.show("Connection failed. Please try again later.", 5000);
        return;
      }
    }

    if (this.playbackState === 'playing') {
      this.session?.pause();
      this.playbackState = 'paused';
      // If we want recording to stop on pause:
      // if (this.recordingState === 'recording') this.stopRecording(); 
    } else if (this.playbackState === 'paused') {
      this.session?.resume();
      this.playbackState = 'playing';
    } else if (this.playbackState === 'stopped' || this.playbackState === 'loading') {
      // If it was 'loading' and user clicked, it implies a retry or start
      if (this.playbackState === 'stopped' && this.session) {
         this.nextStartTime = this.audioContext.currentTime + this.bufferTime;
         this.session.play();
         this.playbackState = 'playing'; // Optimistically set, though session message will confirm
      } else {
         // This might happen if initial connection is still pending or failed and then play is hit
         // Attempt to connect and play if session doesn't exist.
         if (!this.session) {
            await this.connectToSession();
            await this.setSessionPrompts();
         }
         if (this.session && !this.connectionError) {
            this.nextStartTime = this.audioContext.currentTime + this.bufferTime;
            this.session.play();
            this.playbackState = 'playing';
         }
      }
    }
  };

  private stopMusic(resetStartTime = true) {
    if (this.playbackState === 'stopped' && this.session?.currentState?.type !== 'playing' && this.session?.currentState?.type !== 'paused') { // Avoid redundant stops
      return;
    }
    this.session?.stop();
    if (resetStartTime) {
      this.nextStartTime = 0;
    }
    this.playbackState = 'stopped';
    if (this.recordingState === 'recording') {
      this.stopRecording(); // Stop recording when music explicitly stops
    }
  }
  
  private handlePromptChange(e: CustomEvent<Prompt>) {
    const changedPrompt = e.detail;
    this.prompts.set(changedPrompt.promptId, changedPrompt);
    this.setSessionPromptsThrottled();
    this.requestUpdate('prompts'); 
  }

  private setSessionPromptsThrottled = throttle(() => this.setSessionPrompts(), 500);

  private toggleShowMidi() {
    this.showMidi = !this.showMidi;
  }
  
  private async refreshMidiDeviceList() {
    this.midiInputIds = await this.midiDispatcher.getMidiAccess();
    if (this.midiDispatcher.activeMidiInputId && !this.midiInputIds.includes(this.midiDispatcher.activeMidiInputId)) {
        this.midiDispatcher.activeMidiInputId = this.midiInputIds.length > 0 ? this.midiInputIds[0] : null;
    } else if (!this.midiDispatcher.activeMidiInputId && this.midiInputIds.length > 0) {
        this.midiDispatcher.activeMidiInputId = this.midiInputIds[0];
    }
    this.activeMidiInputId = this.midiDispatcher.activeMidiInputId;
    this.requestUpdate();
  }

  private handleMidiInputChange(e: Event) {
    const select = e.target as HTMLSelectElement;
    this.midiDispatcher.activeMidiInputId = select.value;
    this.activeMidiInputId = select.value;
    this.requestUpdate(); // For activeMidiInputId changes
  }

  // --- Recording Logic ---
  private toggleRecording() {
    if (!this.isMediaRecorderSupported) {
        this.toastMessage.show("Recording is not supported by your browser.", 3000);
        return;
    }
    if (this.recordingState === 'recorded_available') {
      this.downloadRecordedAudio();
    } else if (this.recordingState === 'recording') {
      this.stopRecording();
    } else { // 'idle'
      this.startRecording();
    }
  }

  private startRecording() {
    if (!this.recordingStreamDestination || !this.isMediaRecorderSupported) {
      this.toastMessage.show("Recording setup failed.", 3000);
      return;
    }
    if (this.lastRecordingUrl) {
      URL.revokeObjectURL(this.lastRecordingUrl);
      this.lastRecordingUrl = null;
    }
    this.recordedChunks = [];
    
    // Determine preferred MIME type
    const mimeTypes = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'];
    let selectedMimeType = '';
    for (const mime of mimeTypes) {
        if (MediaRecorder.isTypeSupported(mime)) {
            selectedMimeType = mime;
            break;
        }
    }
    if (!selectedMimeType) { // Fallback if none of the preferred are supported
        selectedMimeType = 'audio/webm'; // A common default
        if(!MediaRecorder.isTypeSupported(selectedMimeType) && MediaRecorder.isTypeSupported('')) {
             selectedMimeType = ''; // Let browser pick
        } else if (!MediaRecorder.isTypeSupported(selectedMimeType)) {
            this.toastMessage.show("No suitable audio format for recording found.", 4000);
            this.recordingState = 'idle';
            return;
        }
    }
    this.lastRecordingMimeType = selectedMimeType;

    try {
        this.mediaRecorder = new MediaRecorder(this.recordingStreamDestination.stream, { mimeType: selectedMimeType });
    } catch (e) {
        console.error("Error creating MediaRecorder:", e);
        this.toastMessage.show(`Recording init error: ${(e as Error).message}`, 4000);
        this.recordingState = 'idle';
        return;
    }

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.recordedChunks.push(event.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      if (this.recordedChunks.length === 0) {
        console.warn("No data recorded.");
        this.recordingState = 'idle';
        this.requestUpdate('recordingState');
        return;
      }
      const blob = new Blob(this.recordedChunks, { type: this.lastRecordingMimeType });
      this.lastRecordingUrl = URL.createObjectURL(blob);
      this.recordingState = 'recorded_available';
      this.requestUpdate('recordingState'); // Ensure UI updates
      this.toastMessage.show("Recording ready for download!", 3000);
    };
    
    this.mediaRecorder.onerror = (event) => {
        console.error("MediaRecorder error:", event);
        this.toastMessage.show(`Recording error: ${(event as any)?.error?.name || 'Unknown error'}`, 4000);
        this.recordingState = 'idle';
        if (this.mediaRecorder?.state === 'recording') this.mediaRecorder.stop();
    };

    this.mediaRecorder.start();
    this.recordingState = 'recording';
    this.toastMessage.show("Recording started...", 2000);
  }

  private stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop(); // onstop will handle state update to recorded_available
      // No toast here, onstop or onerror will provide feedback
    } else {
      // If somehow stopRecording is called when not actually recording (e.g. init error)
      this.recordingState = 'idle';
    }
  }

  private downloadRecordedAudio() {
    if (!this.lastRecordingUrl) return;
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = this.lastRecordingUrl;
    const fileExtension = this.lastRecordingMimeType.includes('ogg') ? 'ogg' : 'webm';
    a.download = `prompt_dj_recording_${new Date().toISOString()}.${fileExtension}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Do not revoke immediately, user might want to download again. Revoke when new recording starts.
    this.toastMessage.show("Download started.", 2000);
    // After download, revert button to idle state
    this.recordingState = 'idle'; 
    // Optionally, keep lastRecordingUrl until a new recording starts or page unloads
    // For now, let's clear it to free resources and ensure button reverts fully
    // URL.revokeObjectURL(this.lastRecordingUrl); 
    // this.lastRecordingUrl = null;
    this.requestUpdate('recordingState');
  }

  // --- Preset Logic ---
  private loadUserPresets() {
    this.userPresets = getStoredPresets();
  }

  private saveUserPresets() {
    savePresetsToStorage(this.userPresets);
    this.requestUpdate('userPresets'); // Ensure browser and modal get updated lists
  }

  private handleOpenPresetBrowser() {
    this.isPresetBrowserOpen = true;
  }

  private handleClosePresetBrowser() {
    this.isPresetBrowserOpen = false;
  }

  private handleOpenSavePresetModal(isEditing = false, presetToEdit: Preset | null = null) {
    this.editingPreset = isEditing && presetToEdit ? presetToEdit : null;
    if (this.savePresetModalElement) {
        this.savePresetModalElement.isEditing = !!this.editingPreset;
        this.savePresetModalElement.presetName = this.editingPreset?.name || '';
        this.savePresetModalElement.presetDescription = this.editingPreset?.description || '';
        this.savePresetModalElement.presetCategory = this.editingPreset?.category || DEFAULT_CATEGORY;
    }
    this.isSavePresetModalOpen = true;
  }
  
  private handleCancelSavePreset() {
    this.isSavePresetModalOpen = false;
    this.editingPreset = null;
  }

  private handleSavePresetDetails(e: CustomEvent<{name: string, description: string, category: string}>) {
    const { name, description, category } = e.detail;
    const promptsToSave: StoredPromptConfig[] = Array.from(this.prompts.values()).map(p => ({
      promptId: p.promptId,
      text: p.text,
      weight: p.weight,
      cc: p.cc,
      color: p.color,
    }));

    if (this.editingPreset) {
      const index = this.userPresets.findIndex(p => p.id === this.editingPreset!.id);
      if (index > -1) {
        this.userPresets[index] = {
          ...this.userPresets[index],
          name,
          description,
          category: category || DEFAULT_CATEGORY,
          prompts: promptsToSave,
          updatedAt: Date.now(),
        };
        this.toastMessage.show(`Preset "${name}" updated.`);
      }
    } else {
      const newPreset: Preset = {
        id: crypto.randomUUID(),
        name,
        description,
        category: category || DEFAULT_CATEGORY,
        prompts: promptsToSave,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.userPresets.push(newPreset);
      this.toastMessage.show(`Preset "${name}" saved.`);
    }
    this.saveUserPresets();
    this.handleCancelSavePreset(); // Closes modal and resets editingPreset
  }
  
  private handleEditPresetRequest(e: CustomEvent<string>) {
    const presetId = e.detail;
    const preset = this.userPresets.find(p => p.id === presetId);
    if (preset) {
      this.handleOpenSavePresetModal(true, preset);
      // Don't close browser, modal will appear on top
    }
  }

  private handleLoadPreset(e: CustomEvent<string>) {
    const presetId = e.detail;
    const preset = this.userPresets.find(p => p.id === presetId);
    if (preset) {
      preset.prompts.forEach(storedPrompt => {
        const targetPrompt = this.prompts.get(storedPrompt.promptId);
        if (targetPrompt) {
          targetPrompt.text = storedPrompt.text;
          targetPrompt.weight = storedPrompt.weight;
          targetPrompt.cc = storedPrompt.cc;
          targetPrompt.color = storedPrompt.color;
        }
      });
      this.requestUpdate('prompts'); // This should trigger re-render of prompt-controllers
      this.setSessionPrompts();
      this.toastMessage.show(`Preset "${preset.name}" loaded.`);
      this.isPresetBrowserOpen = false; // Close browser after loading
    }
  }

  private handleDeletePreset(e: CustomEvent<string>) {
    const presetId = e.detail;
    const presetName = this.userPresets.find(p=>p.id === presetId)?.name || "Preset";
    this.userPresets = this.userPresets.filter(p => p.id !== presetId);
    this.saveUserPresets();
    this.toastMessage.show(`Preset "${presetName}" deleted.`);
  }

  private handleDuplicatePreset(e: CustomEvent<string>) {
    const presetId = e.detail;
    const original = this.userPresets.find(p => p.id === presetId);
    if (original) {
      const duplicate: Preset = {
        ...original,
        id: crypto.randomUUID(),
        name: `${original.name} (Copy)`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.userPresets.push(duplicate);
      this.saveUserPresets();
      this.toastMessage.show(`Preset "${original.name}" duplicated.`);
    }
  }

  private handleImportPresets(e: CustomEvent<Preset[]>) {
    const importedPresets = e.detail;
    let addedCount = 0;
    let updatedCount = 0;

    importedPresets.forEach(importedP => {
      // Basic validation for imported preset structure
      if (!importedP.id || !importedP.name || !Array.isArray(importedP.prompts)) {
          console.warn("Skipping invalid preset during import:", importedP);
          return;
      }
      const existingIndex = this.userPresets.findIndex(p => p.id === importedP.id);
      if (existingIndex > -1) {
        // Update existing: take imported, but keep newer date if local is newer
        this.userPresets[existingIndex] = {
            ...importedP, // Base with imported
            prompts: importedP.prompts.map(ip => ({...ip})), // Deep copy prompts
            updatedAt: Math.max(this.userPresets[existingIndex].updatedAt, importedP.updatedAt || Date.now()),
            createdAt: this.userPresets[existingIndex].createdAt, // Keep original creation date
        };
        updatedCount++;
      } else {
        this.userPresets.push({
            ...importedP,
            prompts: importedP.prompts.map(ip => ({...ip})), // Deep copy prompts
            createdAt: importedP.createdAt || Date.now(),
            updatedAt: importedP.updatedAt || Date.now()
        });
        addedCount++;
      }
    });
    this.saveUserPresets();
    this.toastMessage.show(`Presets imported: ${addedCount} new, ${updatedCount} updated.`, 4000);
  }

  private handleExportPresets() {
    if (this.userPresets.length === 0) {
      this.toastMessage.show("No presets to export.", 3000);
      return;
    }
    const dataStr = JSON.stringify(this.userPresets, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    
    const exportFileDefaultName = `prompt-dj-presets-${new Date().toISOString().slice(0,10)}.json`;
    
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
    linkElement.remove();
    this.toastMessage.show("Presets exported.", 3000);
  }

  private renderRecordButtonIcon() {
    if (this.recordingState === 'recording') {
      return svg`<circle cx="12" cy="12" r="6" fill="currentColor"/>`; // Solid circle for recording
    } else if (this.recordingState === 'recorded_available') {
      return svg`<path d="M12 15l-5-5h3V4h4v6h3l-5 5zm-7 2h14v2H5v-2z" fill="currentColor"/>`; // Download icon
    }
    // Idle state icon
    return svg`<circle cx="12" cy="12" r="5" stroke="currentColor" stroke-width="2" fill="none"/>`; // Hollow circle or simple dot
  }

  override render() {
    const promptElements = Array.from(this.prompts.values()).map(
      (p) => html`<prompt-controller
        .promptId=${p.promptId}
        .text=${p.text}
        .weight=${p.weight}
        .color=${p.color}
        .cc=${p.cc}
        .midiDispatcher=${this.midiDispatcher}
        .audioLevel=${this.audioLevel * p.weight}
        .showCC=${this.showMidi}
        ?filtered=${this.filteredPrompts.has(p.promptId)}
        @prompt-changed=${this.handlePromptChange}></prompt-controller>`,
    );

    const existingCategories = [...new Set(this.userPresets.map(p => p.category || DEFAULT_CATEGORY))];

    return html`
      <toast-message></toast-message>
      
      ${this.isSavePresetModalOpen ? html`
        <save-preset-modal
          .presetName=${this.editingPreset?.name || ''}
          .presetDescription=${this.editingPreset?.description || ''}
          .presetCategory=${this.editingPreset?.category || DEFAULT_CATEGORY}
          .existingCategories=${existingCategories}
          ?isEditing=${!!this.editingPreset}
          @save-preset-details=${this.handleSavePresetDetails}
          @cancel-save-preset=${this.handleCancelSavePreset}
        ></save-preset-modal>
      ` : nothing}

      ${this.isPresetBrowserOpen ? html`
        <preset-browser-view
          .presets=${this.userPresets}
          @close-preset-browser=${this.handleClosePresetBrowser}
          @load-preset=${this.handleLoadPreset}
          @edit-preset-request=${this.handleEditPresetRequest}
          @delete-preset=${this.handleDeletePreset}
          @duplicate-preset=${this.handleDuplicatePreset}
          @import-presets=${this.handleImportPresets}
          @export-presets=${this.handleExportPresets}
        ></preset-browser-view>
      ` : nothing}

      <div id="controls-header">
        <button 
            class="header-control"
            @click=${() => this.handleOpenSavePresetModal(false)}
            title="Save current settings as a new preset">
            Save Preset
        </button>
        <button 
            class="header-control"
            @click=${this.handleOpenPresetBrowser}
            title="Open preset browser">
            Presets
        </button>
        <button
          @click=${this.toggleShowMidi}
          class="header-control ${this.showMidi ? 'active' : ''}"
          aria-pressed=${this.showMidi}
          title=${this.showMidi ? 'Hide MIDI CC assignments' : 'Show MIDI CC assignments'}>
          MIDI CC
        </button>
        ${this.isMidiSupported && this.midiInputIds.length > 0 ? html`
          <select 
            class="header-control"
            @change=${this.handleMidiInputChange} 
            .value=${this.activeMidiInputId || ''} 
            aria-label="Select MIDI Input Device">
            ${this.midiInputIds.map(id => html`
              <option value=${id}>${this.midiDispatcher.getDeviceName(id) || id}</option>
            `)}
          </select>
        ` : html`<span class="header-control" style="cursor:default;opacity:0.7;">${this.isMidiSupported ? 'No MIDI devices' : 'MIDI N/A'}</span>`}
         ${this.connectionError ? html`<button class="header-control" @click=${this.connectToSession}>Reconnect</button>` : nothing}
      </div>
      
      <div id="background" style=${styleMap({
        backgroundImage: `radial-gradient(circle at center, ${
          this.prompts.get('prompt-0')?.color ?? '#000000'
        }33, transparent 70vmin)`})}>
      </div>
      
      <div id="grid">${promptElements}</div>
      
      <div class="main-controls-container">
        <play-pause-button 
            .playbackState=${this.playbackState}
            @click=${this.handlePlayPauseClick}
            ?disabled=${this.connectionError && this.playbackState !== 'loading'}>
        </play-pause-button>
        <button 
            id="record-button"
            class=${classMap({
                recording: this.recordingState === 'recording',
                recorded_available: this.recordingState === 'recorded_available'
            })}
            @click=${this.toggleRecording}
            title=${this.recordingState === 'recording' ? 'Stop Recording' : (this.recordingState === 'recorded_available' ? 'Download Recording' : 'Start Recording')}
            aria-label=${this.recordingState === 'recording' ? 'Stop Recording' : (this.recordingState === 'recorded_available' ? 'Download Recording' : 'Start Recording')}
            ?disabled=${!this.isMediaRecorderSupported || (this.playbackState === 'loading' && this.recordingState !== 'recording')}>
            <svg viewBox="0 0 24 24" width="24" height="24">${this.renderRecordButtonIcon()}</svg>
        </button>
      </div>
    `;
  }
}

const initialPrompts = new Map(
  DEFAULT_PROMPTS_CONFIG.map((p, i) => {
    const promptId = `prompt-${i}`;
    return [
      promptId,
      {
        promptId: promptId,
        text: p.text,
        weight: 0, // Initial weights, often first one is 1
        cc: 20 + i, // Default CCs, can be customized
        color: p.color,
      },
    ];
  }),
);
// Example: Make the first prompt initially active by default
// if (initialPrompts.has('prompt-0')) {
//   initialPrompts.get('prompt-0')!.weight = 1;
// }

const midiDispatcher = new MidiDispatcher();
document.body.append(
  new PromptDjMidi(initialPrompts, midiDispatcher),
);
document.body.append(new ToastMessage()); // Ensure toast is available globally if needed, or scope locally.
                                          // Current PromptDjMidi queries for it, so it's fine here.

// Global error handlers (optional but good for unhandled promise rejections)
window.addEventListener('unhandledrejection', function(event) {
  console.error('Unhandled promise rejection:', event.reason);
  const toast = document.querySelector('toast-message');
  toast?.show(`Async Error: ${event.reason?.message || 'Unknown error'}`, 5000);
});
window.addEventListener('error', function(event) {
  console.error('Global error:', event.error);
   const toast = document.querySelector('toast-message');
   // Avoid too many toasts for minor errors, filter if needed
   // toast?.show(`Error: ${event.message || 'Unknown client error'}`, 5000);
});

console.log("Prompt DJ MIDI Loaded");
