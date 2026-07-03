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
  private isAuthenticated: boolean = false
  private currentBalance: number = 0
  private currentStake: number = 500
  private threshold: number = 50
  // null = nothing chosen yet (on load and after each round)
  private direction: 'OVER' | 'UNDER' | null = null

  // Slider
  private sliderTrack!: Phaser.GameObjects.Graphics
  private sliderFill!: Phaser.GameObjects.Graphics
  private sliderGlow!: Phaser.GameObjects.Graphics
  private sliderThumb!: Phaser.GameObjects.Graphics
  private sliderHit!: Phaser.GameObjects.Rectangle

  // Buttons
  private overContainer!:  Phaser.GameObjects.Container
  private underContainer!: Phaser.GameObjects.Container
  private overBtn!:  Phaser.GameObjects.Graphics
  private underBtn!: Phaser.GameObjects.Graphics
  private overText!:  Phaser.GameObjects.Text
  private underText!: Phaser.GameObjects.Text
  private btnW: number = 0
  private btnH: number = 0

  // Stats
  private multiplierText!: Phaser.GameObjects.Text
  private winChanceText!:  Phaser.GameObjects.Text
  private thresholdText!:  Phaser.GameObjects.Text

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
  private sliderX: number = 0
  private sliderY: number = 0
  private sliderW: number = 0

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
      this.isAuthenticated = true
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
      if (type === 'PLACE_BET') {
        if (this.isPlacing) return
        this.currentStake = payload.stake
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

    // ── Subtle background grid ─────────────────────────────────────────
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

    // ── Layout constants ────────────────────────────────────────────────
    // We work purely top-down here so each zone is independent.
    // Generous vertical gaps prevent the "too dense" look.

    const titleSize  = Math.round(Math.min(W * 0.095, 36))
    const subSize    = Math.round(Math.min(W * 0.028, 11))
    const titleY     = Math.max(24, H * 0.052)
    const subY       = titleY + Math.round(titleSize * 0.72) + 8

    // Dice sits between subtitle and slider — takes ~35% of canvas height
    const diceTop    = subY + subSize + 18
    const diceZoneH  = H * 0.35
    this.diceSize    = Math.round(Math.min(W * 0.35, diceZoneH * 0.78, 150))
    const diceY      = diceTop + diceZoneH / 2

    // Threshold number — just below dice zone
    const threshY    = diceTop + diceZoneH + 8
    const threshSize = Math.round(Math.min(W * 0.115, 44))

    // Slider — below threshold
    const sliderGapT = 14
    const sliderZoneY = threshY + threshSize / 2 + 16 + sliderGapT

    // Stats row — below slider
    const statsGap   = 22
    const statsY     = sliderZoneY + 52 + statsGap

    // Buttons — below stats
    this.btnH  = Math.round(Math.min(50, H * 0.063))
    this.btnW  = Math.round(W * 0.38)
    const btnY = statsY + 16 + this.btnH / 2 + 10

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
      this.add.text(cx, subY, 'SLIDE · ROLL · WIN BIG', {
        fontSize: `${subSize}px`, fontFamily: 'Arial, sans-serif',
        color: '#7B4DBF',
      }).setOrigin(0.5)
    )

    // ── Dice ───────────────────────────────────────────────────────────
    this.createDice(cx, diceY)

    // Roll result label — below dice, above threshold
    const resultLabelY = diceTop + diceZoneH - 4
    this.rollResultText = this.add.text(cx, resultLabelY, '', {
      fontSize: '12px', fontFamily: 'Arial, sans-serif', color: '#8866CC',
    }).setOrigin(0.5)
    this.rootContainer.add(this.rollResultText)

    // ── Threshold ──────────────────────────────────────────────────────
    this.thresholdText = this.add.text(cx, threshY, String(this.threshold), {
      fontSize: `${threshSize}px`, fontFamily: 'Arial Black, sans-serif',
      fontStyle: 'bold', color: '#ffffff',
    }).setOrigin(0.5)
    this.rootContainer.add(this.thresholdText)

    // ── Slider ────────────────────────────────────────────────────────
    this.setupSlider(W, sliderZoneY)

    // ── Stats row ─────────────────────────────────────────────────────
    const statSize = Math.round(Math.min(W * 0.044, 17))
    const statXL   = cx - W * 0.22
    const statXR   = cx + W * 0.22

    this.multiplierText = this.add.text(statXL, statsY, '—', {
      fontSize: `${statSize}px`, fontFamily: 'Arial, sans-serif',
      color: '#FFD700', fontStyle: 'bold',
    }).setOrigin(0.5)
    this.rootContainer.add(this.multiplierText)

    this.winChanceText = this.add.text(statXR, statsY, '—', {
      fontSize: `${Math.round(statSize * 0.85)}px`, fontFamily: 'Arial, sans-serif',
      color: '#9B4DFF',
    }).setOrigin(0.5)
    this.rootContainer.add(this.winChanceText)

    const dividerLine = this.add.graphics()
    dividerLine.lineStyle(1, 0x9B4DFF, 0.25)
    dividerLine.lineBetween(cx, statsY - 10, cx, statsY + 10)
    this.rootContainer.add(dividerLine)

    // ── Direction buttons ─────────────────────────────────────────────
    this.setupDirectionButtons(W, btnY)

    // ── Overlay ───────────────────────────────────────────────────────
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

    // Ambient glow pulse
    this.tweens.add({
      targets: this.diceGlow, alpha: { from: 0.5, to: 0.95 },
      duration: 1400, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    })

    // Idle float
    this.diceIdleTween = this.tweens.add({
      targets: this.diceContainer, y: diceY - 7,
      duration: 1700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    })
  }

  private drawDiceFace(fillColor: number, borderColor: number) {
    const s = this.diceSize
    this.diceBody.clear()
    // Drop shadow
    this.diceBody.fillStyle(0x000000, 0.5)
    this.diceBody.fillRoundedRect(-s / 2 + 6, -s / 2 + 8, s, s, 18)
    // Main face
    this.diceBody.fillStyle(fillColor, 1)
    this.diceBody.fillRoundedRect(-s / 2, -s / 2, s, s, 18)
    // Inner subtle gradient (brighter centre)
    this.diceBody.fillStyle(0xFFFFFF, 0.04)
    this.diceBody.fillRoundedRect(-s / 2 + 6, -s / 2 + 6, s - 12, s - 12, 13)
    // Neon border
    this.diceBody.lineStyle(2.5, borderColor, 1)
    this.diceBody.strokeRoundedRect(-s / 2, -s / 2, s, s, 18)
    // Inner border ring
    this.diceBody.lineStyle(1, borderColor, 0.25)
    this.diceBody.strokeRoundedRect(-s / 2 + 7, -s / 2 + 7, s - 14, s - 14, 12)

    // Corner-highlight sheen
    this.diceSheen.clear()
    this.diceSheen.fillStyle(0xFFFFFF, 0.15)
    this.diceSheen.fillRoundedRect(-s / 2 + 2, -s / 2 + 2, s * 0.5, s * 0.38, { tl: 15, tr: 6, bl: 0, br: 0 })
    this.diceSheen.fillStyle(0xFFFFFF, 0.07)
    this.diceSheen.fillRoundedRect(-s / 2 + 5, -s / 2 + 5, s * 0.28, s * 0.18, 5)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SLIDER
  // ─────────────────────────────────────────────────────────────────────────
  private setupSlider(W: number, sliderY: number) {
    this.sliderW = W * 0.80
    this.sliderX = (W - this.sliderW) / 2
    this.sliderY = sliderY

    this.sliderGlow  = this.add.graphics()
    this.sliderTrack = this.add.graphics()
    this.sliderFill  = this.add.graphics()
    this.sliderThumb = this.add.graphics()
    this.rootContainer.add([this.sliderGlow, this.sliderTrack, this.sliderFill, this.sliderThumb])

    this.drawSlider()

    this.tweens.add({
      targets: this.sliderGlow, alpha: { from: 0.3, to: 0.7 },
      duration: 1200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    })

    this.sliderHit = this.add.rectangle(
      this.sliderX + this.sliderW / 2, this.sliderY,
      this.sliderW + 44, 56
    ).setInteractive({ draggable: true, useHandCursor: true })
    this.rootContainer.add(this.sliderHit)

    const setFromX = (x: number) => {
      const clamped = Phaser.Math.Clamp(x, this.sliderX, this.sliderX + this.sliderW)
      const pct = (clamped - this.sliderX) / this.sliderW
      this.threshold = Math.round(2 + pct * 96)
      this.drawSlider()
      this.updateStats()
    }

    this.sliderHit.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      setFromX(pointer.x)
      this.sound.play('tick', { volume: 0.28 })
      this.spawnThumbRing()
    })
    this.sliderHit.on('drag', (_p: Phaser.Input.Pointer, dragX: number) => {
      setFromX(dragX)
      this.sound.play('tick', { volume: 0.18 })
    })
  }

  private drawSlider() {
    const thumbX = this.sliderX + ((this.threshold - 2) / 96) * this.sliderW
    const trackH = 12
    const r      = trackH / 2

    this.sliderGlow.clear()
    this.sliderGlow.fillStyle(PRIMARY, 0.15)
    this.sliderGlow.fillRoundedRect(this.sliderX - 5, this.sliderY - trackH - 3, this.sliderW + 10, trackH * 2 + 6, r + 5)

    this.sliderTrack.clear()
    this.sliderTrack.fillStyle(0x0A001E, 1)
    this.sliderTrack.fillRoundedRect(this.sliderX, this.sliderY - r, this.sliderW, trackH, r)
    this.sliderTrack.lineStyle(1, PRIMARY, 0.2)
    this.sliderTrack.strokeRoundedRect(this.sliderX, this.sliderY - r, this.sliderW, trackH, r)

    this.sliderFill.clear()
    const dir = this.direction ?? 'OVER'
    if (dir === 'OVER') {
      if (thumbX > this.sliderX + r) {
        this.sliderFill.fillStyle(LOSE_COLOR, 0.65)
        this.sliderFill.fillRoundedRect(this.sliderX, this.sliderY - r, thumbX - this.sliderX, trackH, r)
      }
      if (thumbX < this.sliderX + this.sliderW - r) {
        this.sliderFill.fillStyle(WIN_COLOR, 0.65)
        this.sliderFill.fillRoundedRect(thumbX, this.sliderY - r, this.sliderX + this.sliderW - thumbX, trackH, r)
      }
    } else {
      if (thumbX > this.sliderX + r) {
        this.sliderFill.fillStyle(WIN_COLOR, 0.65)
        this.sliderFill.fillRoundedRect(this.sliderX, this.sliderY - r, thumbX - this.sliderX, trackH, r)
      }
      if (thumbX < this.sliderX + this.sliderW - r) {
        this.sliderFill.fillStyle(LOSE_COLOR, 0.65)
        this.sliderFill.fillRoundedRect(thumbX, this.sliderY - r, this.sliderX + this.sliderW - thumbX, trackH, r)
      }
    }

    // Thumb
    this.sliderThumb.clear()
    this.sliderThumb.fillStyle(PRIMARY, 0.28)
    this.sliderThumb.fillCircle(thumbX, this.sliderY, 22)
    this.sliderThumb.fillStyle(0xFFFFFF, 0.12)
    this.sliderThumb.fillCircle(thumbX, this.sliderY, 16)
    this.sliderThumb.fillStyle(0xFFFFFF, 1)
    this.sliderThumb.fillCircle(thumbX, this.sliderY, 11)
    this.sliderThumb.lineStyle(2, PRIMARY_ALT, 1)
    this.sliderThumb.strokeCircle(thumbX, this.sliderY, 11)
    // Specular
    this.sliderThumb.fillStyle(0xFFFFFF, 0.8)
    this.sliderThumb.fillCircle(thumbX - 3, this.sliderY - 3, 3.5)
  }

  private spawnThumbRing() {
    const thumbX = this.sliderX + ((this.threshold - 2) / 96) * this.sliderW
    const ring = this.add.graphics().setDepth(4)
    ring.lineStyle(2, PRIMARY_ALT, 0.85)
    ring.strokeCircle(0, 0, 12)
    ring.setPosition(thumbX, this.sliderY)
    this.tweens.add({ targets: ring, scaleX: 3, scaleY: 3, alpha: 0, duration: 360, ease: 'Power2', onComplete: () => ring.destroy() })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DIRECTION BUTTONS
  // ─────────────────────────────────────────────────────────────────────────
  private setupDirectionButtons(W: number, btnY: number) {
    const gap   = W * 0.05
    const overX = this.cx - gap / 2 - this.btnW / 2
    const undX  = this.cx + gap / 2 + this.btnW / 2

    this.overContainer  = this.add.container(overX, btnY)
    this.underContainer = this.add.container(undX, btnY)
    this.rootContainer.add([this.overContainer, this.underContainer])

    this.overBtn  = this.add.graphics()
    this.underBtn = this.add.graphics()

    const fontSize = `${Math.round(Math.min(W * 0.042, 16))}px`
    this.overText  = this.add.text(0, 0, 'OVER',  { fontSize, fontFamily: 'Arial Black, sans-serif', color: '#ffffff' }).setOrigin(0.5)
    this.underText = this.add.text(0, 0, 'UNDER', { fontSize, fontFamily: 'Arial Black, sans-serif', color: '#ffffff' }).setOrigin(0.5)

    this.overContainer.add([this.overBtn, this.overText])
    this.underContainer.add([this.underBtn, this.underText])

    // Start with null direction — neither button highlighted
    this.drawDirectionButtons()

    const overHit  = this.add.rectangle(0, 0, this.btnW, this.btnH).setInteractive({ useHandCursor: true })
    const underHit = this.add.rectangle(0, 0, this.btnW, this.btnH).setInteractive({ useHandCursor: true })
    this.overContainer.add(overHit)
    this.underContainer.add(underHit)

    const press = (c: Phaser.GameObjects.Container) => {
      this.tweens.add({ targets: c, scaleX: 0.93, scaleY: 0.93, duration: 60, yoyo: true, ease: 'Sine.easeOut' })
    }
    overHit.on('pointerdown', () => {
      press(this.overContainer)
      if (this.direction === 'OVER') return
      this.direction = 'OVER'
      this.drawDirectionButtons()
      this.drawSlider()
      this.updateStats()
      this.sound.play('select', { volume: 0.5 })
    })
    underHit.on('pointerdown', () => {
      press(this.underContainer)
      if (this.direction === 'UNDER') return
      this.direction = 'UNDER'
      this.drawDirectionButtons()
      this.drawSlider()
      this.updateStats()
      this.sound.play('select', { volume: 0.5 })
    })
  }

  private drawDirectionButtons() {
    const bw = this.btnW
    const bh = this.btnH
    const r  = Math.round(bh / 2)

    // OVER button
    this.overBtn.clear()
    if (this.direction === 'OVER') {
      // Active state — filled green
      this.overBtn.fillStyle(WIN_COLOR, 1)
      this.overBtn.fillRoundedRect(-bw/2, -bh/2, bw, bh, r)
      this.overBtn.fillStyle(0xFFFFFF, 0.16)
      this.overBtn.fillRoundedRect(-bw/2 + 4, -bh/2 + 4, bw * 0.48, bh * 0.42, r - 2)
      this.overText.setColor('#05001A')
    } else {
      // Neutral / inactive state — just a bordered outline
      this.overBtn.lineStyle(1.5, this.direction === null ? 0x9B4DFF : 0x3D2060, 0.55)
      this.overBtn.fillStyle(0x0D0030, 1)
      this.overBtn.fillRoundedRect(-bw/2, -bh/2, bw, bh, r)
      this.overBtn.strokeRoundedRect(-bw/2, -bh/2, bw, bh, r)
      this.overText.setColor(this.direction === null ? '#C87DFF' : '#3D2060')
    }

    // UNDER button
    this.underBtn.clear()
    if (this.direction === 'UNDER') {
      this.underBtn.fillStyle(LOSE_COLOR, 1)
      this.underBtn.fillRoundedRect(-bw/2, -bh/2, bw, bh, r)
      this.underBtn.fillStyle(0xFFFFFF, 0.16)
      this.underBtn.fillRoundedRect(-bw/2 + 4, -bh/2 + 4, bw * 0.48, bh * 0.42, r - 2)
      this.underText.setColor('#ffffff')
    } else {
      this.underBtn.lineStyle(1.5, this.direction === null ? 0x9B4DFF : 0x3D2060, 0.55)
      this.underBtn.fillStyle(0x0D0030, 1)
      this.underBtn.fillRoundedRect(-bw/2, -bh/2, bw, bh, r)
      this.underBtn.strokeRoundedRect(-bw/2, -bh/2, bw, bh, r)
      this.underText.setColor(this.direction === null ? '#C87DFF' : '#3D2060')
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // STATS
  // ─────────────────────────────────────────────────────────────────────────
  private updateStats() {
    if (this.direction === null) {
      // No direction chosen yet — show neutral placeholder
      this.multiplierText.setText('—')
      this.winChanceText.setText('—')
      return
    }
    const winChance  = this.direction === 'OVER' ? (100 - this.threshold) / 100 : this.threshold / 100
    const multiplier = parseFloat((0.90 / winChance).toFixed(4))
    this.multiplierText.setText(`${multiplier.toFixed(2)}×`)
    this.winChanceText.setText(`Win: ${(winChance * 100).toFixed(2)}%`)
    this.thresholdText.setText(String(this.threshold))

    this.tweens.killTweensOf(this.thresholdText)
    this.tweens.add({ targets: this.thresholdText, scale: 1.1, duration: 90, yoyo: true, ease: 'Sine.easeOut' })

    window.parent.postMessage({
      type: 'PICK_SELECTED',
      payload: { pick: `${this.direction} ${this.threshold}`, threshold: this.threshold, direction: this.direction, multiplier },
    }, this.PARENT_ORIGIN)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PLACE BET
  // ─────────────────────────────────────────────────────────────────────────
  public placeBet() {
    if (this.isPlacing || !this.isAuthenticated || this.direction === null) return
    if (this.currentBalance < this.currentStake) { this.showError('Insufficient balance'); return }
    this.isPlacing = true
    this.sound.play('click', { volume: 0.6 })

    this.diceIdleTween?.stop(); this.diceIdleTween = undefined

    // Phase 1 — Squash (compress down before jump)
    this.tweens.add({
      targets: this.diceContainer,
      scaleX: 1.22, scaleY: 0.72, duration: 100, ease: 'Power3.easeIn',
      onComplete: () => {
        // Phase 2 — Launch into air (quick upward pop with rotation)
        this.tweens.add({
          targets: this.diceContainer,
          y: this.diceOriginalY - this.diceSize * 0.85,
          scaleX: 0.88, scaleY: 0.88,
          angle: 180,
          duration: 220, ease: 'Power2.easeOut',
          onComplete: () => this.startRollCycle()
        })
      }
    })

    this.rollSound = this.sound.add('roll')
    this.rollSound.play({ volume: 0.25, loop: false })

    this.bridge.placeBet({
      game: 'OLM_DICE',
      stake: this.currentStake,
      gameParams: { threshold: this.threshold, direction: this.direction },
      clientSeed: Math.random().toString(36).substring(2),
    })
  }

  private startRollCycle() {
    // Mid-air spin cycle — runs until handleResult fires
    this.tweens.add({
      targets: this.diceContainer,
      angle: '+=360', scaleX: 1, scaleY: 1,
      duration: 320, ease: 'Linear', repeat: -1,
      onRepeat: () => {
        const rand = (Math.random() * 100).toFixed(2)
        this.diceValueText.setText(rand)
        this.rollResultText.setText(rand)
        this.sound.play('tick', { volume: 0.15 })
        this.spawnRollSparks(2)
      }
    })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HANDLE RESULT — landing animation + result reveal
  // ─────────────────────────────────────────────────────────────────────────
  private handleResult(result: BetResult) {
    const roll   = (result.result as { roll: number }).roll
    const win    = result.win
    const payout = result.payout
    const newBal = result.newBalance

    if (this.rollSound?.isPlaying) this.rollSound.stop()

    // Stop mid-air spin
    this.tweens.killTweensOf(this.diceContainer)

    // Final flash cycle before landing
    let flashCount = 0
    const flashTimer = this.time.addEvent({
      delay: 60, repeat: 8,
      callback: () => {
        flashCount++
        const rand = flashCount < 8 ? (Math.random() * 100).toFixed(2) : roll.toFixed(2)
        this.diceValueText.setText(rand)
        this.rollResultText.setText(rand)
        if (flashCount < 8) this.sound.play('tick', { volume: 0.22 })
      }
    })

    // Phase 3 — Fall back down
    this.time.delayedCall(200, () => {
      this.tweens.add({
        targets: this.diceContainer,
        y: this.diceOriginalY, angle: 360,
        scaleX: 1.25, scaleY: 0.65,
        duration: 260, ease: 'Power3.easeIn',
        onComplete: () => {
          flashTimer.remove()
          this.diceValueText.setText(roll.toFixed(2))
          this.rollResultText.setText(roll.toFixed(2))

          // Color dice by win/loss
          if (win) {
            this.drawDiceFace(0x001a00, WIN_COLOR)
          } else {
            this.drawDiceFace(0x1a0000, LOSE_COLOR)
          }

          // Show dots if in range
          const rounded = Math.round(roll)
          if (rounded >= 1 && rounded <= 6) this.showDiceDots(rounded)

          // Phase 4 — Bounce back (overshoot then settle)
          this.tweens.add({
            targets: this.diceContainer,
            scaleX: 0.88, scaleY: 1.18,
            duration: 80, ease: 'Power2.easeOut',
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

          // Impact effects
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
      this.tweens.add({
        targets: g,
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        alpha: 0, scale: 0.1, duration: 420 + Math.random() * 200, ease: 'Power2',
        onComplete: () => g.destroy()
      })
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
      this.tweens.add({
        targets: g, x: cx + Math.cos(angle) * ed, y: cy + Math.sin(angle) * ed,
        alpha: 0, duration: 240 + Math.random() * 140, ease: 'Power2',
        onComplete: () => g.destroy()
      })
    }
  }

  private spawnShockwave(win: boolean) {
    const ring = this.add.graphics().setDepth(6)
    ring.lineStyle(3.5, win ? WIN_COLOR : LOSE_COLOR, 0.85)
    ring.strokeCircle(0, 0, this.diceSize * 0.5)
    ring.setPosition(this.diceContainer.x, this.diceOriginalY)
    this.tweens.add({ targets: ring, scaleX: 2.8, scaleY: 2.8, alpha: 0, duration: 480, ease: 'Power2', onComplete: () => ring.destroy() })

    // Second outer ring, delayed
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
      .setText(win ? `₦${payout.toLocaleString()} · Roll: ${roll.toFixed(2)}` : `Rolled ${roll.toFixed(2)} · Better luck next time`)
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

          // Reset dice visual
          this.drawDiceFace(0x18004A, PRIMARY)
          this.diceValueText.setText('?').setColor('#ffffff')
          this.rollResultText.setText('')
          this.diceContainer.setScale(1).setAngle(0).setPosition(this.cx, this.diceOriginalY)

          // Remove dots
          const dots = this.diceContainer.list.filter(
            c => c instanceof Phaser.GameObjects.Graphics && c !== this.diceBody && c !== this.diceGlow && c !== this.diceSheen
          )
          dots.forEach(d => (d as Phaser.GameObjects.Graphics).destroy())

          // Resume idle float
          this.diceIdleTween = this.tweens.add({
            targets: this.diceContainer, y: this.diceOriginalY - 7,
            duration: 1700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
          })

          // BUG FIX: reset direction to null so neither button is highlighted
          // and the player must consciously re-pick OVER or UNDER each round
          this.direction = null
          this.drawDirectionButtons()
          this.drawSlider()
          this.multiplierText.setText('—')
          this.winChanceText.setText('—')

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