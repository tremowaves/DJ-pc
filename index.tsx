/**
 * @fileoverview Control real time music with a MIDI controller
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { css, html, LitElement, svg, CSSResultGroup } from 'lit';
import { customElement, property, query, state } from 'lit/decorators';
import { styleMap } from 'lit/directives/style-map';
import { classMap } from 'lit/directives/class-map';

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

interface ControlChange {
  channel: number;
  cc: number;
  value: number;
}

type PlaybackState = 'stopped' | 'playing' | 'loading' | 'paused';

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

const DEFAULT_PROMPTS = [
  { color: '#d8ff3e', text: 'ambient chillout D Minor scale 78 BPM - glass percussion, ethereal pads, celesta - structure: sparse intro (8 bars), verse (24 bars), climax (16 bars), gentle outro (16 bars)' },
{ color: '#d8ff3e', text: 'ambient chillout D Minor scale 78 BPM - glass percussion, ethereal pads, celesta - structure: sparse intro (8 bars), verse (24 bars), climax (16 bars), gentle outro (16 bars) - effects: reverb' },
{ color: '#d8ff3e', text: 'ambient chillout D Minor scale 78 BPM - glass percussion, ethereal pads, celesta - structure: sparse intro (8 bars), verse (24 bars), climax (16 bars), gentle outro (16 bars) - effects: delay' },
{ color: '#d8ff3e', text: 'ambient chillout D Minor scale 78 BPM - glass percussion, ethereal pads, celesta - structure: sparse intro (8 bars), verse (24 bars), climax (16 bars), gentle outro (16 bars) - focus: high frequencies' },
{ color: '#d8ff3e', text: 'ambient chillout D Minor scale 78 BPM - glass percussion, ethereal pads, celesta - structure: sparse intro (8 bars), verse (24 bars), climax (16 bars), gentle outro (16 bars) - focus: mid frequencies' },
{ color: '#d8ff3e', text: 'ambient chillout D Minor scale 78 BPM - glass percussion, ethereal pads, celesta - structure: sparse intro (8 bars), verse (24 bars), climax (16 bars), gentle outro (16 bars) - focus: low frequencies' },
{ color: '#d8ff3e', text: 'ambient chillout D Minor scale 78 BPM - glass percussion, ethereal pads, celesta - structure: sparse intro (8 bars), verse (24 bars), climax (16 bars), gentle outro (16 bars) - volume: fade in/out' },
{ color: '#d8ff3e', text: 'ambient chillout D Minor scale 78 BPM - glass percussion, ethereal pads, celesta - structure: sparse intro (8 bars), verse (24 bars), climax (16 bars), gentle outro (16 bars) - filter cutoff' },


];

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
      transition: transform 0.5s cubic-bezier(0.19, 1, 0.22, 1);
      z-index: 1000;
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
    .toast:not(.showing) {
      transition-duration: 1s;
      transform: translate(-50%, -200%);
    }
  `;

  @property({ type: String }) message = '';
  @property({ type: Boolean }) showing = false;

  override render() {
    return html`<div class=${classMap({ showing: this.showing, toast: true })}>
      <div class="message">${this.message}</div>
      <button @click=${this.hide} aria-label="Close message">✕</button>
    </div>`;
  }

  show(message: string) {
    this.showing = true;
    this.message = message;
  }

  hide() {
    this.showing = false;
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
      // requestUpdate is called by Lit automatically when properties change
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
    // Ensure thumb doesn't go beyond track boundaries visually
    const thumbPositionPercent = Math.max(0, Math.min(100, fillHeightPercent)); 

    const fillStyle = styleMap({
      height: `${fillHeightPercent}%`,
    });

    // Center thumb vertically on its value position
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
      /* For debugging hitbox: border: 1px solid red; */
    }
  ` as CSSResultGroup;

  // Method to be implemented by subclasses to provide the specific icon SVG
  protected renderIcon() {
    return svg``; // Default empty icon
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

/** A button for toggling play/pause. */
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
      /* width is set by weight-slider's own styles (e.g., 30px) */
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
      /* margin-top: 0.5vmin; Removed, relying on justify-content */
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
       /* No nowrap ellipsis by default to allow multiline view */
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
    } else if (cc === this.cc) {
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

  private updateWeight(event: CustomEvent<number>) { // Listen to CustomEvent from slider
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
      grid-auto-rows: 1fr; /* Make rows equally sized based on available height */
      gap: 2.5vmin;
      margin-top: max(8vmin, 60px); 
      padding-bottom: 2vmin; 
      z-index: 1; 
    }
    prompt-controller { 
      width: 100%;
      height: 100%; /* Ensure prompt-controller fills the grid cell */
    }
    play-pause-button {
      position: relative; 
      width: clamp(100px, 15vmin, 140px); 
      height: clamp(100px, 15vmin, 140px);
      margin-top: 3vmin; 
      z-index: 1;
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
    button, #controls-header select { 
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
      transition: background-color 0.2s, color 0.2s;
      &:hover {
        background-color: rgba(255,255,255,0.8);
        color: #000;
      }
      &.active {
        background-color: #fff;
        color: #000;
      }
    }
     #controls-header select {
      background: #fff; 
      color: #000;
      padding: 8px 10px;
    }
    #controls-header select:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    @media only screen and (max-width: 768px) {
      #grid {
        width: 90vmin;
        height: 90vmin;
        gap: 2vmin;
        margin-top: max(12vmin, 80px); 
      }
       play-pause-button {
         width: clamp(80px, 18vmin, 120px);
         height: clamp(80px, 18vmin, 120px);
       }
    }
     @media only screen and (max-width: 480px) {
        #controls-header {
            justify-content: center; 
        }
        #grid {
            grid-template-columns: repeat(2, 1fr); 
            width: 95vmin;
            height: auto; 
            max-height: calc(95vmin * 2); 
            overflow-y: auto; 
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

  private session: LiveMusicSession | null = null; 
  private audioContext!: AudioContext; 
  private outputNode!: GainNode; 
  private nextStartTime = 0;
  private readonly bufferTime = 1; 

  @state() private showMidi = false;
  @state() private audioLevel = 0;
  @state() private midiInputIds: string[] = [];
  @state() private activeMidiInputId: string | null = null;
  @state() private isMidiSupported = !!navigator.requestMIDIAccess;


  @state() private filteredPrompts = new Set<string>();

  private audioLevelRafId: number | null = null;
  @state() private connectionError = false; 

  @query('play-pause-button') private playPauseButton!: PlayPauseButton;
  @query('toast-message') private toastMessage!: ToastMessage;

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
  }

  private initAudio() {
    if (!this.audioContext || this.audioContext.state === 'closed') {
        const AudioContextConstructor = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioContextConstructor) {
            console.error("Web Audio API is not supported in this browser.");
            this.playbackState = 'stopped'; 
            this.toastMessage?.show("Web Audio API not supported. Music playback disabled.");
            return;
        }
        this.audioContext = new AudioContextConstructor({ sampleRate: 48000 });
        this.outputNode = this.audioContext.createGain();
        this.outputNode.connect(this.audioContext.destination); 
        
        this.audioAnalyser = new AudioAnalyser(this.audioContext);
        this.audioAnalyser.node.connect(this.audioContext.destination); 
        this.outputNode.connect(this.audioAnalyser.node); 
    } else if (this.audioAnalyser && this.audioAnalyser.node.context !== this.audioContext) {
        this.audioAnalyser = new AudioAnalyser(this.audioContext);
        this.audioAnalyser.node.connect(this.audioContext.destination);
        if (this.outputNode) {
          this.outputNode.connect(this.audioAnalyser.node);
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
          onmessage: async (e: LiveMusicServerMessage) => {
            if (e.setupComplete) {
              this.connectionError = false;
              if (this.playbackState === 'loading' && this.getPromptsToSend().length > 0) {
                 // this.playbackState = 'paused'; 
              }
              console.log("Session setup complete.");
            }
            if (e.filteredPrompt) {
              const newFiltered = new Set(this.filteredPrompts);
              newFiltered.add(e.filteredPrompt.text);
              this.filteredPrompts = newFiltered;
              this.toastMessage.show(`Prompt "${e.filteredPrompt.text}" filtered: ${e.filteredPrompt.filteredReason}`);
              this.requestUpdate(); 
            }
            if (e.serverContent?.audioChunks !== undefined) {
              if (this.playbackState === 'paused' || this.playbackState === 'stopped' || !this.session || !this.audioContext) return;
              
              if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
              }

              const audioBuffer = await decodeAudioData(
                decode(e.serverContent?.audioChunks[0].data),
                this.audioContext,
                48000, 
                2, 
              );
              const source = this.audioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(this.outputNode);
              
              const currentTime = this.audioContext.currentTime;
              if (this.nextStartTime === 0) { 
                this.nextStartTime = currentTime + this.bufferTime;
                setTimeout(() => {
                    if(this.playbackState === 'loading') this.playbackState = 'playing';
                }, (this.bufferTime * 1000) / 2);
              }

              if (this.nextStartTime < currentTime) { 
                console.warn("Audio buffer underrun, resetting start time.");
                this.playbackState = 'loading'; 
                this.nextStartTime = currentTime + this.bufferTime; 
              }
              source.start(this.nextStartTime);
              this.nextStartTime += audioBuffer.duration;
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error('LiveMusicSession error:', e);
            this.connectionError = true;
            this.stop(); 
            this.toastMessage.show('Connection error. Please try restarting audio.');
            this.playbackState = 'stopped'; 
          },
          onclose: (e: CloseEvent) => {
            if (this.session && !e.wasClean && this.playbackState !== 'stopped') {
                console.warn('LiveMusicSession closed unexpectedly:', e);
                this.connectionError = true;
                this.stop();
                this.toastMessage.show('Connection closed. Please restart audio.');
                this.playbackState = 'stopped';
            } else {
                console.log('LiveMusicSession closed.');
            }
          },
        },
      });
    } catch (error: any) {
        console.error("Failed to connect to LiveMusicSession:", error);
        this.toastMessage.show(`Failed to connect: ${error.message}`);
        this.connectionError = true;
        this.playbackState = 'stopped';
    }
  }

  private getPromptsToSend() {
    return Array.from(this.prompts.values())
      .filter((p) => {
        return p.text.trim() !== '' && !this.filteredPrompts.has(p.text) && p.weight > 0;
      })
  }

  private setSessionPrompts = throttle(async () => {
    if (!this.session || this.connectionError) {
      return;
    }

    const promptsToSend = this.getPromptsToSend();
    if (promptsToSend.length === 0 && (this.playbackState === 'playing' || this.playbackState === 'loading')) {
      this.toastMessage.show('No active prompts. Music paused. Turn up a slider or edit a prompt to resume.')
      this.pause(); 
      return;
    }
    
    if (this.playbackState === 'paused' && promptsToSend.length > 0) {
        // User needs to explicitly press play again
    }

    if (this.playbackState === 'playing' || this.playbackState === 'loading' || promptsToSend.length > 0 ) {
      try {
        await this.session.setWeightedPrompts({
          weightedPrompts: promptsToSend.map(p => ({text: p.text, weight: p.weight})),
        });
        const activeTexts = new Set(promptsToSend.map(p => p.text));
        let changedFiltered = false;
        const newFilteredPrompts = new Set<string>();
        for (const filteredText of this.filteredPrompts) {
            if (activeTexts.has(filteredText)) {
                newFilteredPrompts.add(filteredText);
            } else {
                changedFiltered = true; 
            }
        }
        if (changedFiltered) {
            this.filteredPrompts = newFilteredPrompts;
        }

      } catch (e: any) {
        this.toastMessage.show(`Error setting prompts: ${e.message}`);
        this.pause(); 
      }
    }
  }, 200); 

  private updateAudioLevel() {
    this.audioLevelRafId = requestAnimationFrame(this.updateAudioLevel);
    if (this.audioContext && this.audioContext.state === 'running' && this.audioAnalyser) {
      this.audioLevel = this.audioAnalyser.getCurrentLevel();
    } else {
      this.audioLevel = 0;
    }
  }

  private dispatchPromptsChange() { 
    setStoredPrompts(this.prompts); 
    return this.setSessionPrompts(); 
  }

  private handlePromptChanged(e: CustomEvent<Prompt>) {
    const { promptId, text, weight, cc } = e.detail;
    const prompt = this.prompts.get(promptId);

    if (!prompt) {
      console.error('prompt not found for ID:', promptId);
      return;
    }
    
    let changed = false;
    if (prompt.text !== text) {
        if (this.filteredPrompts.has(prompt.text)) {
            const newFiltered = new Set(this.filteredPrompts);
            newFiltered.delete(prompt.text);
            this.filteredPrompts = newFiltered;
        }
        prompt.text = text;
        changed = true;
    }
    if (prompt.weight !== weight) {
        prompt.weight = Math.max(0, Math.min(2, weight)); 
        changed = true;
    }
    if (prompt.cc !== cc) {
        prompt.cc = cc;
        changed = true;
    }

    if (changed) {
      const newPrompts = new Map(this.prompts);
      newPrompts.set(promptId, { ...prompt }); 
      this.setPrompts(newPrompts); 
    }
  }

  private setPrompts(newPrompts: Map<string, Prompt>) {
    this.prompts = newPrompts;
    this.requestUpdate(); 
    this.dispatchPromptsChange(); 
  }

  private readonly makeBackground = throttle(
    () => {
      const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);

      const MAX_WEIGHT_FOR_ALPHA = 1.0; 
      const MAX_ALPHA = 0.6; 

      const bg: string[] = [];

      [...this.prompts.values()].forEach((p, i) => {
        if (p.weight <= 0) return; 

        const alphaPct = clamp01(p.weight / MAX_WEIGHT_FOR_ALPHA) * MAX_ALPHA;
        const alpha = Number.isFinite(alphaPct) ? Math.round(alphaPct * 0xff)
          .toString(16)
          .padStart(2, '0') : '00';

        const numCols = 4;
        const col = i % numCols;
        const row = Math.floor(i / numCols);
        
        const x = (col + 0.5) / numCols; 
        const y = (row + 0.5) / Math.ceil(this.prompts.size / numCols); 

        const stopDistance = (p.weight / 2) * 50; 

        const s = `radial-gradient(circle at ${x * 100}% ${y * 100}%, ${p.color}${alpha} 0%, ${p.color}00 ${clamp01(stopDistance / 100) * 100}%)`;
        bg.push(s);
      });

      return bg.length > 0 ? bg.join(', ') : 'transparent'; 
    },
    50, 
  );

  private async pause() {
    if (!this.audioContext || !this.outputNode) return; 
    if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume(); 
    }
    this.session?.pause();
    this.playbackState = 'paused';
    this.outputNode.gain.setValueAtTime(this.outputNode.gain.value, this.audioContext.currentTime);
    this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.1);
  }

  private async play() {
    this.initAudio(); 
    if (!this.audioContext || !this.outputNode) { 
        this.playbackState = 'stopped'; 
        return;
    }
    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }
    
    if (this.connectionError || !this.session) {
        this.toastMessage.show('Reconnecting to music service...');
        await this.connectToSession(); 
        if (this.connectionError || !this.session) { 
            this.toastMessage.show('Connection failed. Please try again later.');
            this.playbackState = 'stopped';
            return;
        }
    }

    const promptsToSend = this.getPromptsToSend();
    if (promptsToSend.length === 0) {
      this.toastMessage.show('Add a prompt or turn up a slider to start playing.')
      this.playbackState = 'paused'; 
      return;
    }

    this.session?.play();
    this.playbackState = 'loading'; 
    this.outputNode.gain.setValueAtTime(0, this.audioContext.currentTime); 
    this.outputNode.gain.linearRampToValueAtTime(1, this.audioContext.currentTime + 0.2); 
    
    await this.setSessionPrompts();
  }

  private stop() { 
    this.session?.stop(); 
    this.playbackState = 'stopped';
    if (this.audioContext && this.outputNode) {
        this.outputNode.gain.setValueAtTime(this.outputNode.gain.value, this.audioContext.currentTime);
        this.outputNode.gain.linearRampToValueAtTime(0, this.audioContext.currentTime + 0.1);
    }
    this.nextStartTime = 0; 
  }

  private async handlePlayPause() {
    if (this.playbackState === 'playing') {
      this.pause();
    } else if (this.playbackState === 'paused' || this.playbackState === 'stopped') {
      await this.play();
    } else if (this.playbackState === 'loading') { 
      this.stop();
    }
  }
  
  private async refreshMidiDeviceList() {
    if (!this.isMidiSupported) return;
    const oldInputId = this.activeMidiInputId;
    const inputIds = await this.midiDispatcher.getMidiAccess();
    this.midiInputIds = inputIds;
    if (this.midiDispatcher.activeMidiInputId && inputIds.includes(this.midiDispatcher.activeMidiInputId)) {
        this.activeMidiInputId = this.midiDispatcher.activeMidiInputId;
    } else if (inputIds.length > 0) {
        this.activeMidiInputId = inputIds[0];
        this.midiDispatcher.activeMidiInputId = inputIds[0];
    } else {
        this.activeMidiInputId = null;
        this.midiDispatcher.activeMidiInputId = null;
    }
    if (oldInputId !== this.activeMidiInputId && this.activeMidiInputId) {
        console.log("MIDI Input changed to:", this.midiDispatcher.getDeviceName(this.activeMidiInputId));
    }
    this.requestUpdate();
  }


  private async toggleShowMidi() {
    this.showMidi = !this.showMidi;
    if (this.showMidi && this.isMidiSupported) {
      await this.refreshMidiDeviceList();
    }
  }

  private handleMidiInputChange(event: Event) {
    const selectElement = event.target as HTMLSelectElement;
    const newMidiId = selectElement.value;
    if (newMidiId !== this.activeMidiInputId) {
        this.activeMidiInputId = newMidiId;
        this.midiDispatcher.activeMidiInputId = newMidiId;
        if (newMidiId) {
            console.log("MIDI Input manually selected:", this.midiDispatcher.getDeviceName(newMidiId));
        }
    }
  }

  private resetAllPrompts() {
    if(confirm("Are you sure you want to reset all prompts and MIDI CC assignments to default? This cannot be undone.")){
        this.filteredPrompts = new Set(); 
        this.setPrompts(buildDefaultPrompts()); 
        this.toastMessage.show("All prompts reset to default.");
    }
  }

  override render() {
    const bg = styleMap({
      backgroundImage: this.makeBackground(),
    });
    return html`<div id="background" style=${bg} aria-hidden="true"></div>
      <div id="controls-header">
        <button
          @click=${this.toggleShowMidi}
          class=${this.showMidi ? 'active' : ''}
          aria-pressed=${this.showMidi}
          aria-controls="midi-device-selector"
          title=${this.isMidiSupported ? (this.showMidi ? "Hide MIDI Settings" : "Show MIDI Settings") : "Web MIDI API not supported"}
          ?disabled=${!this.isMidiSupported}
          >MIDI ${this.isMidiSupported ? (this.showMidi ? 'ON' : 'OFF') : '(N/A)'}</button
        >
        <select
          id="midi-device-selector"
          @change=${this.handleMidiInputChange}
          .value=${this.activeMidiInputId || ''}
          style=${this.showMidi && this.isMidiSupported ? '' : 'display: none;'}
          aria-label="Select MIDI Input Device"
          ?disabled=${this.midiInputIds.length === 0}>
          ${this.midiInputIds.length > 0
        ? this.midiInputIds.map(
          (id) =>
            html`<option value=${id}>
                    ${this.midiDispatcher.getDeviceName(id) || `Unknown Device (ID: ${id.substring(0,10)}...)`}
                  </option>`,
        )
        : html`<option value="">${this.isMidiSupported ? "No MIDI devices found" : "MIDI not supported"}</option>`}
        </select>
        <button @click=${this.resetAllPrompts} title="Reset all prompts to default settings">Reset All</button>
      </div>
      <div id="grid" role="grid" aria-label="Prompt Controllers Grid">
        ${[...this.prompts.values()].map((prompt, index) => {
          return html`<prompt-controller
            role="gridcell"
            .promptId=${prompt.promptId}
            .filtered=${this.filteredPrompts.has(prompt.text)}
            .cc=${prompt.cc}
            .text=${prompt.text}
            .weight=${prompt.weight}
            .color=${prompt.color}
            .midiDispatcher=${this.midiDispatcher}
            .showCC=${this.showMidi && this.isMidiSupported}
            .audioLevel=${this.audioLevel}
            @prompt-changed=${this.handlePromptChanged}>
          </prompt-controller>`;
        })}
      </div>
      <play-pause-button 
        .playbackState=${this.playbackState} 
        @click=${this.handlePlayPause}
        aria-label=${this.playbackState === 'playing' ? 'Pause music' : 'Play music'}
      ></play-pause-button>
      <toast-message></toast-message>`;
  }
}

async function main(parent: HTMLElement) {
  const midiDispatcher = new MidiDispatcher();
  const initialPrompts = getInitialPrompts();

  const pdjMidi = new PromptDjMidi(
    initialPrompts,
    midiDispatcher,
  );
  parent.appendChild(pdjMidi);
}

function getInitialPrompts(): Map<string, Prompt> {
  const { localStorage } = window;
  const storedPrompts = localStorage.getItem('prompts');

  if (storedPrompts) {
    try {
      const parsedArray = JSON.parse(storedPrompts) as Prompt[];
      if (Array.isArray(parsedArray) && parsedArray.every(p => p && typeof p.promptId === 'string')) {
        console.log('Loading stored prompts', parsedArray);
        return new Map(parsedArray.map((prompt) => [prompt.promptId, prompt]));
      } else {
        console.warn('Stored prompts data is malformed. Using default prompts.');
        localStorage.removeItem('prompts'); 
      }
    } catch (e) {
      console.error('Failed to parse stored prompts, using defaults.', e);
      localStorage.removeItem('prompts'); 
    }
  }

  console.log('No valid stored prompts, using default prompts');
  return buildDefaultPrompts();
}

function buildDefaultPrompts(): Map<string, Prompt> {
  const promptsToStart = Math.min(3, DEFAULT_PROMPTS.length);
  const startOn = [...DEFAULT_PROMPTS]
    .sort(() => Math.random() - 0.5) 
    .slice(0, promptsToStart); 

  const prompts = new Map<string, Prompt>();

  DEFAULT_PROMPTS.forEach((template, i) => {
    const promptId = `prompt-${i}`; 
    const { text, color } = template;
    const defaultCC = typeof (template as any)['cc'] === 'number' ? (template as any)['cc'] : i;

    prompts.set(promptId, {
      promptId,
      text,
      weight: startOn.includes(template) ? 1 : 0,
      cc: defaultCC, 
      color,
    });
  });

  return prompts;
}

function setStoredPrompts(prompts: Map<string, Prompt>) {
  try {
    const storedPrompts = JSON.stringify([...prompts.values()]);
    localStorage.setItem('prompts', storedPrompts);
    console.log('Prompts saved to localStorage.');
  } catch (e) {
    console.error('Failed to save prompts to localStorage:', e);
  }
}

main(document.body);

interface MIDIAccessOptions {
  sysex?: boolean;
  software?: boolean;
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
  interface HTMLElementTagNameMap {
    'prompt-dj-midi': PromptDjMidi;
    'prompt-controller': PromptController;
    'weight-slider': WeightSlider; // Changed from weight-knob
    'play-pause-button': PlayPauseButton;
    'toast-message': ToastMessage
  }
  interface Navigator {
    requestMIDIAccess(options?: MIDIAccessOptions): Promise<MIDIAccess>;
  }
}