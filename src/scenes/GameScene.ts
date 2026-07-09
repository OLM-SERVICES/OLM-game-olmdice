import Phaser from 'phaser'
import { CasinoBridge } from '../bridge'
import type { BetResult } from '../bridge'

const PRIMARY     = 0x9B4DFF
const PRIMARY_ALT = 0xC87DFF
const WIN_COLOR   = 0x00E676
const LOSE_COLOR  = 0xFF3A2D
const GOLD        = 0xFFD700
const BG_COLOR    = '#07001F'

export class GameScene extends Phaser.Scene {
  private bridge!: CasinoBridge
  private PARENT_ORIGIN: string = '*'

  private isPlacing: boolean = false
  private currentBalance: number = 0
  private currentStake: number = 500
  private threshold: number = 50
  private direction: 'OVER' | 'UNDER' | null = null

  // Dice
  private diceContainer!:  Phaser.GameObjects.Container
  private diceBody!:       Phaser.GameObjects.Graphics
  private diceGlow!:       Phaser.GameObjects.Graphics
  private diceSheen!:      Phaser.GameObjects.Graphics
  private diceValueText!:  Phaser.GameObjects.Text
  private rollResultText!: Phaser.GameObjects.Text
  private diceIdleTween?:  Phaser.Tweens.Tween
  private diceOriginalY:   number = 0
  private diceSize:        number = 120
  private trailGraphics:   Phaser.GameObjects.Graphics[] = []

  // Title
  private titleGlow!: Phaser.GameObjects.Text
  private titleMain!: Phaser.GameObjects.Text
  private glitchTimer: Phaser.Time.TimerEvent | null = null

  // Overlay
  private overlay!:        Phaser.GameObjects.Graphics
  private overlayText!:    Phaser.GameObjects.Text
  private overlaySubText!: Phaser.GameObjects.Text

  private aurora1!: Phaser.GameObjects.Graphics
  private aurora2!: Phaser.GameObjects.Graphics
  private auroraTime: number = 0
  private bgGrid!:  Phaser.GameObjects.Graphics

  private rootContainer!: Phaser.GameObjects.Container
  private cx: number = 0

  private rollSound!: Phaser.Sound.BaseSound
  private messageHandler: ((event: MessageEvent) => void) | null = null
  private resizeTimer: Phaser.Time.TimerEvent | null = null
  private uiInitialized: boolean = false

  constructor() { super('GameScene') }

  preload() {
    this.load.audio('background', '/sounds/background-olmdice.mp3')
    this.load.audio('click',      '/sounds/click-olmdice.mp3')
    this.load.audio('select',     '/sounds/select-olmdice.mp3')
    this.load.audio('tick',       '/sounds/tick-olmdice.mp3')
    this.load.audio('win',        '/sounds/win-olmdice.mp3')
    this.load.audio('loss',       '/sounds/loss-olmdice.mp3')
    this.load.audio('roll',       '/sounds/roll-olmdice.mp3')
  }

  create() {
    this.sound.pauseOnBlur = false
    this.PARENT_ORIGIN = import.meta.env.VITE_PARENT_ORIGIN || '*'
    this.bridge = new CasinoBridge(this.PARENT_ORIGIN)

    this.bridge.onInit((balance: number) => {
      this.currentBalance = balance
      window.parent.postMessage({ type: 'BALANCE_UPDATE', payload: { balance } }, this.PARENT_ORIGIN)
    })
    this.bridge.onResult((result: BetResult) => this.handleResult(result))
    this.bridge.onErr((msg: string) => {
      this.showError(msg)
      this.isPlacing = false
      window.parent.postMessage({ type: 'BET_DONE', payload: {} }, this.PARENT_ORIGIN)
    })

    if (this.messageHandler) window.removeEventListener('message', this.messageHandler)
    this.messageHandler = (event: MessageEvent) => {
      if (this.PARENT_ORIGIN !== '*' && event.origin !== this.PARENT_ORIGIN) return
      const { type, payload } = event.data || {}

      // The pick UI (OVER/UNDER + slider) now lives in the React panel.
      // It pushes the current direction/threshold here so the dice can
      // stay in sync, and so the matching sound effect still plays —
      // previously that lived in the in-canvas button/slider handlers.
      if (type === 'PICK_SELECTED') {
        const directionChanged = !!payload?.direction && payload.direction !== this.direction
        const thresholdChanged = payload?.threshold != null && payload.threshold !== this.threshold

        if (payload?.direction) this.direction = payload.direction
        if (payload?.threshold != null) this.threshold = payload.threshold

        if (directionChanged) {
          this.sound.play('select', { volume: 0.5 })
        } else if (thresholdChanged) {
          this.sound.play('tick', { volume: 0.18 })
        }
        return
      }

      if (type === 'PLACE_BET') {
        if (this.isPlacing) return
        this.currentStake = payload.stake
        if (payload?.direction) this.direction = payload.direction
        if (payload?.threshold != null) this.threshold = payload.threshold
        this.placeBet()
      }
    }
    window.addEventListener('message', this.messageHandler)

    this.time.delayedCall(300, () => {
      const ctx = (this.sound as any).context
      if (ctx) ctx.resume()
        .then(() => this.sound.play('background', { loop: true, volume: 0.18 }))
        .catch(() => this.sound.play('background', { loop: true, volume: 0.18 }))
      else this.sound.play('background', { loop: true, volume: 0.18 })
    })

    this.scale.on('resize', this.handleResize, this)
    this.setupUI()

    // Safety net: on mobile, canvas.clientWidth/clientHeight often hasn't
    // settled to its true final value at the exact instant create() runs
    // (address bar collapsing, iframe layout timing). This second pass
    // re-measures and rebuilds once the layout has had a moment to settle.
    this.time.delayedCall(150, () => {
      if (!this.isPlacing) this.setupUI()
    })
  }

  private handleResize() {
    if (this.resizeTimer) { this.resizeTimer.remove(); this.resizeTimer = null }
    this.resizeTimer = this.time.delayedCall(120, () => {
      if (!this.isPlacing) this.setupUI()
    })
  }

  private destroyUI() {
    if (!this.uiInitialized) return
    this.glitchTimer?.remove(); this.glitchTimer = null
    this.diceIdleTween?.stop(); this.diceIdleTween = undefined
    this.trailGraphics.forEach(g => g.destroy()); this.trailGraphics = []
    this.rootContainer?.destroy(true)
  }

  private setupUI() {
    this.destroyUI()

    const canvas = this.sys.game.canvas
    const W = canvas.clientWidth  || this.scale.width
    const H = canvas.clientHeight || this.scale.height
    const cx = W / 2
    this.cx = cx

    this.rootContainer = this.add.container(0, 0)
    this.cameras.main.setBackgroundColor(BG_COLOR)

    // ── Background grid ────────────────────────────────────────────────
    this.bgGrid = this.add.graphics()
    this.bgGrid.lineStyle(1, 0x9B4DFF, 0.045)
    const GRID_SZ = 48
    for (let x = 0; x <= W; x += GRID_SZ) { this.bgGrid.moveTo(x, 0); this.bgGrid.lineTo(x, H) }
    for (let y = 0; y <= H; y += GRID_SZ) { this.bgGrid.moveTo(0, y); this.bgGrid.lineTo(W, y) }
    this.bgGrid.strokePath()
    this.rootContainer.add(this.bgGrid)

    this.aurora1 = this.add.graphics()
    this.aurora2 = this.add.graphics()
    this.rootContainer.add([this.aurora1, this.aurora2])

    // ── Layout — title up top, dice fills the rest. The pick UI (slider,
    // OVER/UNDER, stats, Play button) all live in the React panel now, so
    // the canvas only needs to lay out the title and the dice animation.
    const titleSize = Math.round(Math.min(W * 0.095, 36))
    const subSize   = Math.round(Math.min(W * 0.028, 11))
    const titleY    = Math.max(24, H * 0.08)
    const subY      = titleY + Math.round(titleSize * 0.72) + 8

    const diceTop    = subY + subSize + 20
    const diceBottom = H - 24
    const diceZoneH  = Math.max(diceBottom - diceTop, 80)
    this.diceSize    = Math.round(Math.min(W * 0.34, diceZoneH * 0.55, 160))
    const diceY      = diceTop + diceZoneH / 2
    const resultLabelY = Math.min(diceY + this.diceSize * 0.5 + 26, H - 16)

    // ── Title ──────────────────────────────────────────────────────────
    this.titleGlow = this.add.text(cx, titleY, 'OLM DICE', {
      fontSize: `${titleSize}px`, fontStyle: 'bold',
      fontFamily: 'Arial Black, sans-serif', color: '#C87DFF',
    }).setOrigin(0.5).setAlpha(0.4).setScale(1.06)
    this.rootContainer.add(this.titleGlow)

    this.titleMain = this.add.text(cx, titleY, 'OLM DICE', {
      fontSize: `${titleSize}px`, fontStyle: 'bold',
      fontFamily: 'Arial Black, sans-serif', color: '#FFFFFF',
      stroke: '#9B4DFF', strokeThickness: 2,
    }).setOrigin(0.5)
    this.rootContainer.add(this.titleMain)

    this.rootContainer.add(
      this.add.text(cx, subY, 'SLIDE · PICK · ROLL · WIN BIG', {
        fontSize: `${subSize}px`, fontFamily: 'Arial, sans-serif', color: '#7B4DBF',
      }).setOrigin(0.5)
    )

    // ── Dice ───────────────────────────────────────────────────────────
    this.createDice(cx, diceY)

    this.rollResultText = this.add.text(cx, resultLabelY, '', {
      fontSize: '12px', fontFamily: 'Arial, sans-serif', color: '#8866CC',
    }).setOrigin(0.5)
    this.rootContainer.add(this.rollResultText)

    // ── Overlay ────────────────────────────────────────────────────────
    this.overlay = this.add.graphics().setVisible(false).setDepth(10)
    this.overlayText = this.add.text(cx, H / 2 - 36, '', {
      fontSize: '56px', fontStyle: 'bold',
      fontFamily: 'Arial Black, sans-serif', color: '#FFD700',
    }).setOrigin(0.5).setVisible(false).setDepth(11)
    this.overlaySubText = this.add.text(cx, H / 2 + 30, '', {
      fontSize: '16px', fontFamily: 'Arial, sans-serif', color: '#ffffffCC',
    }).setOrigin(0.5).setVisible(false).setDepth(11)
    this.rootContainer.add([this.overlay, this.overlayText, this.overlaySubText])

    this.uiInitialized = true
    this.startTitleGlitch()
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DICE
  // ─────────────────────────────────────────────────────────────────────────
  private createDice(cx: number, diceY: number) {
    this.diceOriginalY = diceY
    this.diceContainer = this.add.container(cx, diceY)
    this.rootContainer.add(this.diceContainer)

    const s = this.diceSize

    this.diceGlow = this.add.graphics()
    this.diceGlow.fillStyle(PRIMARY, 0.16)
    this.diceGlow.fillCircle(0, 0, s * 0.78)
    this.diceGlow.fillStyle(0x3300AA, 0.08)
    this.diceGlow.fillCircle(0, 0, s * 1.0)

    this.diceBody  = this.add.graphics()
    this.diceSheen = this.add.graphics()

    this.drawDiceFace(0x18004A, PRIMARY)

    this.diceValueText = this.add.text(0, 2, '?', {
      fontSize: `${Math.round(s * 0.30)}px`,
      fontFamily: 'Arial Black, sans-serif', color: '#ffffff',
    }).setOrigin(0.5)

    this.diceContainer.add([this.diceGlow, this.diceBody, this.diceSheen, this.diceValueText])

    this.tweens.add({
      targets: this.diceGlow, alpha: { from: 0.5, to: 0.95 },
      duration: 1400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    })

    this.diceIdleTween = this.tweens.add({
      targets: this.diceContainer, y: diceY - 7,
      duration: 1700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    })
  }

  // Lighten/darken helpers for deriving the top/side face shades from the
  // base front-face color, so the "3D" faces always match the current
  // dice color (idle purple, win green, loss red) automatically.
  private shadeColor(color: number, amt: number): number {
    const r = (color >> 16) & 0xff
    const g = (color >> 8) & 0xff
    const b = color & 0xff
    const adjust = (v: number) => amt >= 0
      ? Math.min(255, Math.round(v + (255 - v) * amt))
      : Math.max(0, Math.round(v * (1 + amt)))
    return (adjust(r) << 16) | (adjust(g) << 8) | adjust(b)
  }

  private drawDiceFace(fillColor: number, borderColor: number) {
    const s     = this.diceSize
    const depth = s * 0.18   // how far the top/side faces are offset — the "3D pop"

    this.diceBody.clear()

    // Drop shadow
    this.diceBody.fillStyle(0x000000, 0.5)
    this.diceBody.fillRoundedRect(-s / 2 + 6, -s / 2 + 8, s, s, 18)

    const topColor  = this.shadeColor(fillColor, 0.38)   // lighter — catches the light
    const sideColor = this.shadeColor(fillColor, -0.35)  // darker — falls into shadow

    // Top face — parallelogram, reads as looking down onto the cube
    this.diceBody.fillStyle(topColor, 1)
    this.diceBody.beginPath()
    this.diceBody.moveTo(-s / 2 + 8, -s / 2)
    this.diceBody.lineTo(-s / 2 + 8 + depth, -s / 2 - depth)
    this.diceBody.lineTo(s / 2 - 8 + depth, -s / 2 - depth)
    this.diceBody.lineTo(s / 2 - 8, -s / 2)
    this.diceBody.closePath()
    this.diceBody.fillPath()

    // Side face — parallelogram, the cube's right-hand edge
    this.diceBody.fillStyle(sideColor, 1)
    this.diceBody.beginPath()
    this.diceBody.moveTo(s / 2, -s / 2 + 8)
    this.diceBody.lineTo(s / 2 + depth, -s / 2 + 8 - depth)
    this.diceBody.lineTo(s / 2 + depth, s / 2 - 8 - depth)
    this.diceBody.lineTo(s / 2, s / 2 - 8)
    this.diceBody.closePath()
    this.diceBody.fillPath()

    // Front face
    this.diceBody.fillStyle(fillColor, 1)
    this.diceBody.fillRoundedRect(-s / 2, -s / 2, s, s, 18)
    this.diceBody.fillStyle(0xFFFFFF, 0.04)
    this.diceBody.fillRoundedRect(-s / 2 + 6, -s / 2 + 6, s - 12, s - 12, 13)
    this.diceBody.lineStyle(2.5, borderColor, 1)
    this.diceBody.strokeRoundedRect(-s / 2, -s / 2, s, s, 18)
    this.diceBody.lineStyle(1, borderColor, 0.25)
    this.diceBody.strokeRoundedRect(-s / 2 + 7, -s / 2 + 7, s - 14, s - 14, 12)

    // Crisp edge lines on the top/side faces so they read as distinct panels
    this.diceBody.lineStyle(1.5, borderColor, 0.5)
    this.diceBody.lineBetween(-s / 2 + 8, -s / 2, -s / 2 + 8 + depth, -s / 2 - depth)
    this.diceBody.lineBetween(-s / 2 + 8 + depth, -s / 2 - depth, s / 2 - 8 + depth, -s / 2 - depth)
    this.diceBody.lineBetween(s / 2 - 8 + depth, -s / 2 - depth, s / 2 - 8, -s / 2)
    this.diceBody.lineBetween(s / 2, -s / 2 + 8, s / 2 + depth, -s / 2 + 8 - depth)
    this.diceBody.lineBetween(s / 2 + depth, -s / 2 + 8 - depth, s / 2 + depth, s / 2 - 8 - depth)
    this.diceBody.lineBetween(s / 2 + depth, s / 2 - 8 - depth, s / 2, s / 2 - 8)

    this.diceSheen.clear()
    this.diceSheen.fillStyle(0xFFFFFF, 0.15)
    this.diceSheen.fillRoundedRect(-s / 2 + 2, -s / 2 + 2, s * 0.5, s * 0.38, { tl: 15, tr: 6, bl: 0, br: 0 })
    this.diceSheen.fillStyle(0xFFFFFF, 0.07)
    this.diceSheen.fillRoundedRect(-s / 2 + 5, -s / 2 + 5, s * 0.28, s * 0.18, 5)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PLACE BET
  // ─────────────────────────────────────────────────────────────────────────
  public placeBet() {
    if (this.isPlacing || this.direction === null) return
    if (this.currentBalance < this.currentStake) { this.showError('Insufficient balance'); return }
    this.isPlacing = true

    this.diceIdleTween?.stop()
    this.diceIdleTween = undefined
    this.diceContainer.setPosition(this.cx, this.diceOriginalY)
    this.startRollCycle()

    this.rollSound = this.sound.add('roll')
    this.rollSound.play({ volume: 0.25, loop: false })

    this.bridge.placeBet({
      game:       'OLM_DICE',
      stake:      this.currentStake,
      gameParams: { threshold: this.threshold, direction: this.direction },
      clientSeed: Math.random().toString(36).substring(2),
    })
  }

  private startRollCycle() {
    // No number readout during the spin — just the dice tumbling on the
    // Z axis (angle rotation) with tick/spark flair. The real number only
    // appears once the roll has actually resolved, in handleResult().
    this.diceValueText.setVisible(false)
    this.rollResultText.setText('Rolling...')

    this.tweens.add({
      targets: this.diceContainer,
      angle: '+=360', scaleX: 1, scaleY: 1,
      duration: 320, ease: 'Linear', repeat: -1,
      onRepeat: () => {
        this.sound.play('tick', { volume: 0.15 })
        this.spawnRollSparks(2)
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HANDLE RESULT
  // ─────────────────────────────────────────────────────────────────────────
  private handleResult(result: BetResult) {
    const roll   = (result.result as { roll: number }).roll
    const win    = result.win
    const payout = result.payout
    const newBal = result.newBalance

    if (this.rollSound?.isPlaying) this.rollSound.stop()
    this.tweens.killTweensOf(this.diceContainer)

    this.time.delayedCall(200, () => {
      this.tweens.add({
        targets: this.diceContainer,
        y: this.diceOriginalY, angle: 360,
        scaleX: 1.25, scaleY: 0.65,
        duration: 260, ease: 'Power3.easeIn',
        onComplete: () => {
          // Roll has fully landed — reveal the real number for the first
          // time here, together with the win/loss face and effects.
          this.diceValueText.setText(roll.toFixed(2)).setVisible(true)
          this.rollResultText.setText(roll.toFixed(2))

          if (win) { this.drawDiceFace(0x001a00, WIN_COLOR) }
          else     { this.drawDiceFace(0x1a0000, LOSE_COLOR) }

          const rounded = Math.round(roll)
          if (rounded >= 1 && rounded <= 6) this.showDiceDots(rounded)

          this.tweens.add({
            targets: this.diceContainer,
            scaleX: 0.88, scaleY: 1.18, duration: 80, ease: 'Power2.easeOut',
            onComplete: () => {
              this.tweens.add({
                targets: this.diceContainer,
                scaleX: win ? 1.14 : 1.04, scaleY: win ? 1.14 : 1.04,
                duration: 160, ease: 'Back.easeOut',
                onComplete: () => {
                  this.tweens.add({ targets: this.diceContainer, scaleX: 1, scaleY: 1, duration: 140, ease: 'Sine.easeOut' })
                }
              })
            }
          })

          this.spawnImpactParticles(win)
          this.spawnShockwave(win)

          const flash = this.add.graphics().setDepth(18)
          flash.fillStyle(win ? WIN_COLOR : LOSE_COLOR, 0.18)
          flash.fillRect(0, 0, this.scale.width, this.scale.height)
          this.tweens.add({ targets: flash, alpha: 0, duration: 380, onComplete: () => flash.destroy() })

          if (win) {
            this.sound.play('win', { volume: 0.8 })
            this.cameras.main.flash(280, 0, 220, 110)
          } else {
            this.sound.play('loss', { volume: 0.7 })
            this.cameras.main.shake(260, 0.007)
          }

          this.time.delayedCall(220, () => this.showResultOverlay(win, roll, payout, newBal))
        }
      })
    })
  }

  private spawnImpactParticles(win: boolean) {
    const cx = this.diceContainer.x
    const cy = this.diceOriginalY + this.diceSize * 0.5
    const color = win ? WIN_COLOR : LOSE_COLOR
    for (let i = 0; i < 14; i++) {
      const g = this.add.graphics().setDepth(7)
      g.fillStyle(i % 3 === 0 ? GOLD : color, 1)
      g.fillCircle(0, 0, 2 + Math.random() * 3)
      g.setPosition(cx + (Math.random() - 0.5) * this.diceSize * 0.5, cy)
      const angle = -Math.PI * 0.5 + (Math.random() - 0.5) * Math.PI * 0.9
      const dist  = 24 + Math.random() * 60
      this.tweens.add({ targets: g, x: cx + Math.cos(angle) * dist, y: cy + Math.sin(angle) * dist, alpha: 0, scale: 0.1, duration: 420 + Math.random() * 200, ease: 'Power2', onComplete: () => g.destroy() })
    }
  }

  private spawnRollSparks(count: number) {
    const cx = this.diceContainer.x
    const cy = this.diceContainer.y
    const colors = [PRIMARY, PRIMARY_ALT, 0xFFFFFF]
    for (let s = 0; s < count; s++) {
      const g = this.add.graphics().setDepth(4)
      g.fillStyle(colors[Math.floor(Math.random() * colors.length)], 1)
      g.fillCircle(0, 0, 2 + Math.random() * 2)
      const angle = Math.random() * Math.PI * 2
      const sd = this.diceSize * 0.3
      const ed = this.diceSize * 0.75
      g.setPosition(cx + Math.cos(angle) * sd, cy + Math.sin(angle) * sd)
      this.tweens.add({ targets: g, x: cx + Math.cos(angle) * ed, y: cy + Math.sin(angle) * ed, alpha: 0, duration: 240 + Math.random() * 140, ease: 'Power2', onComplete: () => g.destroy() })
    }
  }

  private spawnShockwave(win: boolean) {
    const ring = this.add.graphics().setDepth(6)
    ring.lineStyle(3.5, win ? WIN_COLOR : LOSE_COLOR, 0.85)
    ring.strokeCircle(0, 0, this.diceSize * 0.5)
    ring.setPosition(this.diceContainer.x, this.diceOriginalY)
    this.tweens.add({ targets: ring, scaleX: 2.8, scaleY: 2.8, alpha: 0, duration: 480, ease: 'Power2', onComplete: () => ring.destroy() })

    const ring2 = this.add.graphics().setDepth(6)
    ring2.lineStyle(2, win ? WIN_COLOR : LOSE_COLOR, 0.5)
    ring2.strokeCircle(0, 0, this.diceSize * 0.5)
    ring2.setPosition(this.diceContainer.x, this.diceOriginalY)
    this.tweens.add({ targets: ring2, scaleX: 3.6, scaleY: 3.6, alpha: 0, duration: 600, delay: 80, ease: 'Power2', onComplete: () => ring2.destroy() })
  }

  private showDiceDots(value: number) {
    const existingDots = this.diceContainer.list.filter(
      c => c instanceof Phaser.GameObjects.Graphics && c !== this.diceBody && c !== this.diceGlow && c !== this.diceSheen
    )
    existingDots.forEach(c => (c as Phaser.GameObjects.Graphics).destroy())

    const dotR = this.diceSize * 0.08
    const pad  = this.diceSize * 0.22
    const dot = (x: number, y: number) => {
      const g = this.add.graphics()
      g.fillStyle(0xFFFFFF, 0.95)
      g.fillCircle(x, y, dotR)
      g.fillStyle(0xFFFFFF, 0.5)
      g.fillCircle(x - dotR * 0.3, y - dotR * 0.3, dotR * 0.32)
      this.diceContainer.add(g)
    }

    switch (value) {
      case 1: dot(0, 0); break
      case 2: dot(-pad, -pad); dot(pad, pad); break
      case 3: dot(-pad, -pad); dot(0, 0); dot(pad, pad); break
      case 4: dot(-pad, -pad); dot(pad, -pad); dot(-pad, pad); dot(pad, pad); break
      case 5: dot(-pad, -pad); dot(pad, -pad); dot(0, 0); dot(-pad, pad); dot(pad, pad); break
      case 6: dot(-pad, -pad); dot(pad, -pad); dot(-pad, 0); dot(pad, 0); dot(-pad, pad); dot(pad, pad); break
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RESULT OVERLAY
  // ─────────────────────────────────────────────────────────────────────────
  private showResultOverlay(win: boolean, roll: number, payout: number, newBalance: number) {
    const W = this.scale.width, H = this.scale.height
    this.overlay.clear()
    this.overlay.fillStyle(win ? 0x001a00 : 0x1a0000, 0.90)
    this.overlay.fillRect(0, 0, W, H)
    this.overlay.setVisible(true)

    this.overlayText
      .setText(win ? '🎲 WIN!' : 'MISS')
      .setColor(win ? '#FFD700' : '#FF3A2D')
      .setVisible(true).setScale(0.35).setAlpha(1).setAngle(win ? -5 : 0)
    this.tweens.add({ targets: this.overlayText, scale: 1, angle: 0, duration: 380, ease: 'Back.easeOut' })

    this.overlaySubText
      .setText(win
        ? `₦${payout.toLocaleString()} · Roll: ${roll.toFixed(2)}`
        : `Rolled ${roll.toFixed(2)} · Better luck next time`)
      .setVisible(true).setAlpha(0)
    this.tweens.add({ targets: this.overlaySubText, alpha: 1, duration: 400, delay: 300 })

    if (win) {
      for (let i = 0; i < 52; i++) {
        const p = this.add.graphics().setDepth(12)
        const colors = [GOLD, WIN_COLOR, PRIMARY, 0xFFFFFF, PRIMARY_ALT]
        const streak = Math.random() < 0.3
        p.fillStyle(colors[Math.floor(Math.random() * colors.length)], 1)
        if (streak) p.fillRect(-1, -6, 2, 12)
        else p.fillCircle(0, 0, 2 + Math.random() * 4)
        p.setPosition(this.cx, H * 0.38)
        const angle = Math.random() * Math.PI * 2
        const dist  = 70 + Math.random() * 240
        this.tweens.add({
          targets: p,
          x: this.cx + Math.cos(angle) * dist, y: H * 0.38 + Math.sin(angle) * dist,
          rotation: Math.random() * Math.PI, alpha: 0, scale: 0.2,
          duration: 800 + Math.random() * 600, ease: 'Power2',
          onComplete: () => p.destroy()
        })
      }
    }

    this.time.delayedCall(win ? 2600 : 2000, () => {
      this.tweens.add({
        targets: [this.overlay, this.overlayText, this.overlaySubText],
        alpha: 0, duration: 300,
        onComplete: () => {
          this.overlay.setVisible(false).setAlpha(1)
          this.overlayText.setVisible(false).setAlpha(1)
          this.overlaySubText.setVisible(false).setAlpha(1)

          this.drawDiceFace(0x18004A, PRIMARY)
          this.diceValueText.setText('?').setColor('#ffffff').setVisible(true)
          this.rollResultText.setText('')
          this.diceContainer.setScale(1).setAngle(0).setPosition(this.cx, this.diceOriginalY)

          const dots = this.diceContainer.list.filter(
            c => c instanceof Phaser.GameObjects.Graphics && c !== this.diceBody && c !== this.diceGlow && c !== this.diceSheen
          )
          dots.forEach(d => (d as Phaser.GameObjects.Graphics).destroy())

          this.diceIdleTween = this.tweens.add({
            targets: this.diceContainer, y: this.diceOriginalY - 7,
            duration: 1700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
          })

          // Reset direction — player must re-pick each round (the React
          // panel resets its own direction/threshold state independently
          // on BET_DONE, this just keeps the canvas's copy in sync).
          this.direction = null

          this.currentBalance = newBalance
          this.isPlacing      = false

          window.parent.postMessage({ type: 'BET_DONE', payload: { newBalance } }, this.PARENT_ORIGIN)
        }
      })
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // TITLE GLITCH
  // ─────────────────────────────────────────────────────────────────────────
  private startTitleGlitch() {
    if (this.glitchTimer) { this.glitchTimer.remove(); this.glitchTimer = null }
    this.glitchTimer = this.time.delayedCall(Phaser.Math.Between(2800, 6000), () => {
      const dx = Phaser.Math.Between(-3, 3)
      this.titleGlow?.setX(this.cx + dx).setAlpha(0.8)
      this.time.delayedCall(75, () => this.titleGlow?.setX(this.cx).setAlpha(0.4))
      this.startTitleGlitch()
    })
  }

  private showError(message: string) {
    const err = this.add.text(this.scale.width / 2, 70, message, {
      fontSize: '13px', color: '#ff4444',
      backgroundColor: '#1a0000', padding: { x: 12, y: 8 },
    }).setOrigin(0.5).setDepth(20)
    this.time.delayedCall(3000, () => err.destroy())
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UPDATE
  // ─────────────────────────────────────────────────────────────────────────
  update(_time: number, delta: number) {
    this.auroraTime += delta * (this.isPlacing ? 0.0030 : 0.0012)
    const W = this.scale.width, H = this.scale.height

    this.aurora1.clear()
    this.aurora1.fillStyle(PRIMARY, 0.048)
    this.aurora1.fillEllipse(
      W * 0.28 + Math.sin(this.auroraTime * 0.5) * W * 0.18,
      H * 0.36 + Math.cos(this.auroraTime * 0.3) * H * 0.18,
      W * 0.62, H * 0.40
    )
    this.aurora2.clear()
    this.aurora2.fillStyle(0x001FCC, 0.032)
    this.aurora2.fillEllipse(
      W * 0.72 + Math.cos(this.auroraTime * 0.4) * W * 0.22,
      H * 0.64 + Math.sin(this.auroraTime * 0.6) * H * 0.22,
      W * 0.52, H * 0.36
    )
  }
}