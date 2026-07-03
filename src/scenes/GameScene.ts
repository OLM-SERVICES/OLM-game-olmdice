import Phaser from 'phaser'
import { CasinoBridge } from '../bridge'
import type { BetResult } from '../bridge'

const ACCENT      = 0x4B6EF5   // indigo
const ACCENT_GLOW = 0x9B4DFF   // violet accent glow, matches cover art
const WIN_COLOR   = 0x00E676
const LOSE_COLOR  = 0xFF3A2D

export class GameScene extends Phaser.Scene {
  private bridge!: CasinoBridge
  private PARENT_ORIGIN: string = '*'

  private isPlacing: boolean = false
  private isAuthenticated: boolean = false
  private currentBalance: number = 0
  private currentStake: number = 500
  private threshold: number = 50
  private direction: 'OVER' | 'UNDER' = 'OVER'

  // UI
  private sliderTrack!: Phaser.GameObjects.Graphics
  private sliderFill!: Phaser.GameObjects.Graphics
  private sliderGlow!: Phaser.GameObjects.Graphics
  private sliderThumb!: Phaser.GameObjects.Graphics
  private sliderHit!: Phaser.GameObjects.Rectangle

  private overBtn!: Phaser.GameObjects.Graphics
  private underBtn!: Phaser.GameObjects.Graphics
  private overText!: Phaser.GameObjects.Text
  private underText!: Phaser.GameObjects.Text

  private multiplierText!: Phaser.GameObjects.Text
  private winChanceText!: Phaser.GameObjects.Text
  private thresholdText!: Phaser.GameObjects.Text

  private diceContainer!: Phaser.GameObjects.Container
  private diceGraphic!: Phaser.GameObjects.Graphics
  private diceGlow!: Phaser.GameObjects.Graphics
  private diceValueText!: Phaser.GameObjects.Text
  private rollResultText!: Phaser.GameObjects.Text

  private overlay!: Phaser.GameObjects.Graphics
  private overlayText!: Phaser.GameObjects.Text
  private overlaySubText!: Phaser.GameObjects.Text

  private aurora1!: Phaser.GameObjects.Graphics
  private aurora2!: Phaser.GameObjects.Graphics
  private auroraTime: number = 0

  private rootContainer!: Phaser.GameObjects.Container

  private cx: number = 0
  private sliderX: number = 0
  private sliderY: number = 0
  private sliderW: number = 0
  private diceSize: number = 140

  private rollSound!: Phaser.Sound.BaseSound
  private messageHandler: ((event: MessageEvent) => void) | null = null
  private resizeTimer: Phaser.Time.TimerEvent | null = null
  private uiInitialized: boolean = false

  constructor() {
    super('GameScene')
  }

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
      window.parent.postMessage(
        { type: 'BALANCE_UPDATE', payload: { balance } },
        this.PARENT_ORIGIN
      )
    })

    this.bridge.onResult((result: BetResult) => this.handleResult(result))

    this.bridge.onErr((message: string) => {
      this.showError(message)
      this.isPlacing = false
      window.parent.postMessage(
        { type: 'BET_DONE', payload: {} },
        this.PARENT_ORIGIN
      )
    })

    // Guard against duplicate listeners. Previously `scale.on('resize', ...)`
    // called `scene.restart()`, which re-ran create() and added a brand new
    // bridge + message listener every time WITHOUT removing the old ones —
    // after a few resizes a single PLACE_BET could fire placeBet() multiple
    // times. We now rebuild the UI in place instead (see handleResize), and
    // this guard keeps create() itself idempotent as a safety net.
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
      if (ctx) {
        ctx.resume().then(() => {
          this.sound.play('background', { loop: true, volume: 0.2 })
        }).catch(() => {
          this.sound.play('background', { loop: true, volume: 0.2 })
        })
      } else {
        this.sound.play('background', { loop: true, volume: 0.2 })
      }
    })

    // Resize-aware layout: rebuild the UI in place rather than restarting
    // the scene (see guard note above for why restart() was unsafe here).
    this.scale.on('resize', this.handleResize, this)
    this.setupUI()
    this.time.delayedCall(300, () => { if (!this.isPlacing) this.setupUI() })
    this.time.delayedCall(600, () => { if (!this.isPlacing) this.setupUI() })
  }

  private handleResize() {
    if (this.resizeTimer) {
      this.resizeTimer.remove()
      this.resizeTimer = null
    }
    this.resizeTimer = this.time.delayedCall(120, () => {
      // Don't tear down mid-roll — the next resize after the round
      // finishes will pick up the correct layout instead.
      if (this.isPlacing) return
      this.setupUI()
    })
  }

  private destroyUI() {
    if (!this.uiInitialized) return
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
    this.cameras.main.setBackgroundColor('#05001A')

    this.aurora1 = this.add.graphics()
    this.aurora2 = this.add.graphics()
    this.rootContainer.add([this.aurora1, this.aurora2])

    const grid = this.add.graphics()
    grid.lineStyle(1, 0x0A0530, 0.2)
    for (let x = 0; x < W; x += 40) grid.lineBetween(x, 0, x, H)
    for (let y = 0; y < H; y += 40) grid.lineBetween(0, y, W, y)
    grid.strokePath()
    this.rootContainer.add(grid)

    // ── HEADER ───────────────────────────────────────────────────────
    const titleSize = Math.round(Math.min(W * 0.09, 34))
    const titleY    = Math.max(26, Math.round(H * 0.055))

    this.rootContainer.add(
      this.add.text(cx, titleY, 'OLM DICE', {
        fontSize: `${titleSize}px`, fontStyle: 'bold',
        fontFamily: 'Arial, sans-serif', color: '#4B6EF5',
      }).setOrigin(0.5).setAlpha(0.45).setScale(1.06)
    )
    this.rootContainer.add(
      this.add.text(cx, titleY, 'OLM DICE', {
        fontSize: `${titleSize}px`, fontStyle: 'bold',
        fontFamily: 'Arial, sans-serif', color: '#FFFFFF',
        stroke: '#4B6EF5', strokeThickness: 2,
      }).setOrigin(0.5)
    )

    const subSize   = Math.round(Math.min(W * 0.03, 12))
    const subtitleY = titleY + Math.max(22, Math.round(H * 0.035))
    this.rootContainer.add(
      this.add.text(cx, subtitleY, 'ROLL OVER OR UNDER · PROVABLY FAIR', {
        fontSize: `${subSize}px`, fontFamily: 'Arial, sans-serif', color: '#4B6EF5',
      }).setOrigin(0.5)
    )

    const headerEnd = subtitleY + Math.max(20, Math.round(H * 0.03))

    // ── FOOTER, built bottom-up so it always stays on screen ───────────
    const marginB = Math.max(14, Math.round(H * 0.02))
    const statsH  = Math.max(20, Math.round(H * 0.03))
    const statsY  = H - marginB - statsH / 2

    const btnH        = Math.max(42, Math.min(54, Math.round(H * 0.065)))
    const btnGapAbove = Math.max(14, Math.round(H * 0.02))
    const btnY         = statsY - statsH / 2 - btnGapAbove - btnH / 2

    const sliderGapAbove = Math.max(16, Math.round(H * 0.025))
    const sliderHalf     = 20
    const sliderY        = btnY - btnH / 2 - sliderGapAbove - sliderHalf

    const thresholdSize  = Math.round(Math.min(W * 0.09, 34))
    const threshGapAbove = Math.max(12, Math.round(H * 0.018))
    const thresholdY     = sliderY - sliderHalf - threshGapAbove - thresholdSize * 0.5

    const footerTop = thresholdY - thresholdSize * 0.5 - Math.max(16, Math.round(H * 0.02))

    // ── DICE fills whatever space remains in the middle ────────────────
    const availDiceH = Math.max(60, footerTop - headerEnd)
    this.diceSize = Math.max(70, Math.min(150, Math.min(W * 0.36, availDiceH * 0.82)))
    const diceY = headerEnd + availDiceH / 2

    this.createDice(cx, diceY)

    const rollTextY = Math.min(diceY + this.diceSize / 2 + 22, footerTop - 6)
    this.rollResultText = this.add.text(cx, rollTextY, '', {
      fontSize: '16px', fontFamily: 'Arial, sans-serif', color: '#ffffff',
    }).setOrigin(0.5).setAlpha(0.6)
    this.rootContainer.add(this.rollResultText)

    this.thresholdText = this.add.text(cx, thresholdY, String(this.threshold), {
      fontSize: `${thresholdSize}px`, fontFamily: 'Arial, sans-serif',
      fontStyle: 'bold', color: '#ffffff',
    }).setOrigin(0.5)
    this.rootContainer.add(this.thresholdText)

    this.setupSlider(W, sliderY)
    this.setupDirectionButtons(W, btnY, btnH)

    this.multiplierText = this.add.text(cx - W * 0.18, statsY, '1.80×', {
      fontSize: `${Math.round(Math.min(W * 0.05, 20))}px`,
      fontFamily: 'Arial, sans-serif', color: '#FFD700', fontStyle: 'bold',
    }).setOrigin(0.5)
    this.rootContainer.add(this.multiplierText)

    this.winChanceText = this.add.text(cx + W * 0.18, statsY, 'Win: 50.00%', {
      fontSize: `${Math.round(Math.min(W * 0.035, 14))}px`,
      fontFamily: 'Arial, sans-serif', color: '#ffffff',
    }).setOrigin(0.5)
    this.rootContainer.add(this.winChanceText)

    // Overlay
    this.overlay = this.add.graphics().setVisible(false).setDepth(10)
    this.overlayText = this.add.text(cx, H / 2 - 40, '', {
      fontSize: '56px', fontStyle: 'bold',
      fontFamily: 'Arial, sans-serif', color: '#FFD700',
    }).setOrigin(0.5).setVisible(false).setDepth(11)
    this.overlaySubText = this.add.text(cx, H / 2 + 24, '', {
      fontSize: '20px', fontFamily: 'Arial, sans-serif', color: '#ffffff',
    }).setOrigin(0.5).setVisible(false).setDepth(11)
    this.rootContainer.add([this.overlay, this.overlayText, this.overlaySubText])

    this.uiInitialized = true
    this.updateStats()
  }

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

    this.sliderHit = this.add.rectangle(
      this.sliderX + this.sliderW / 2,
      this.sliderY,
      this.sliderW + 40,
      44
    ).setInteractive({ draggable: true, useHandCursor: true })
    this.rootContainer.add(this.sliderHit)

    const setFromX = (x: number) => {
      const clamped = Phaser.Math.Clamp(x, this.sliderX, this.sliderX + this.sliderW)
      const pct = (clamped - this.sliderX) / this.sliderW
      this.threshold = Math.round(2 + pct * 96)
      this.drawSlider()
      this.updateStats()
    }

    // Tap anywhere on the track to jump the thumb there, not just drag —
    // matches the reference art, where the slider reads as tap-friendly.
    this.sliderHit.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      setFromX(pointer.x)
    })

    this.sliderHit.on('drag', (_pointer: Phaser.Input.Pointer, dragX: number) => {
      setFromX(dragX)
      this.sound.play('tick', { volume: 0.25 })
    })
  }

  private drawSlider() {
    const thumbX = this.sliderX + ((this.threshold - 2) / 96) * this.sliderW

    this.sliderGlow.clear()
    this.sliderGlow.fillStyle(ACCENT_GLOW, 0.18)
    this.sliderGlow.fillRoundedRect(this.sliderX - 4, this.sliderY - 10, this.sliderW + 8, 20, 10)

    this.sliderTrack.clear()
    this.sliderTrack.fillStyle(0x1a1a2e, 1)
    this.sliderTrack.fillRoundedRect(this.sliderX, this.sliderY - 6, this.sliderW, 12, 6)

    this.sliderFill.clear()
    if (this.direction === 'OVER') {
      this.sliderFill.fillStyle(LOSE_COLOR, 0.6)
      this.sliderFill.fillRoundedRect(this.sliderX, this.sliderY - 6, thumbX - this.sliderX, 12, 6)
      this.sliderFill.fillStyle(WIN_COLOR, 0.6)
      this.sliderFill.fillRoundedRect(thumbX, this.sliderY - 6, this.sliderX + this.sliderW - thumbX, 12, 6)
    } else {
      this.sliderFill.fillStyle(WIN_COLOR, 0.6)
      this.sliderFill.fillRoundedRect(this.sliderX, this.sliderY - 6, thumbX - this.sliderX, 12, 6)
      this.sliderFill.fillStyle(LOSE_COLOR, 0.6)
      this.sliderFill.fillRoundedRect(thumbX, this.sliderY - 6, this.sliderX + this.sliderW - thumbX, 12, 6)
    }

    this.sliderThumb.clear()
    this.sliderThumb.fillStyle(0xFFFFFF, 0.25)
    this.sliderThumb.fillCircle(thumbX, this.sliderY, 20)
    this.sliderThumb.fillStyle(0xFFFFFF, 1)
    this.sliderThumb.fillCircle(thumbX, this.sliderY, 14)
    this.sliderThumb.lineStyle(3, ACCENT, 1)
    this.sliderThumb.strokeCircle(thumbX, this.sliderY, 14)
  }

  private setupDirectionButtons(W: number, btnY: number, btnHeight: number) {
    const btnWidth = W * 0.35
    const gap      = W * 0.05
    const overX  = this.cx - gap / 2 - btnWidth / 2
    const underX = this.cx + gap / 2 + btnWidth / 2

    this.overBtn  = this.add.graphics()
    this.underBtn = this.add.graphics()
    this.rootContainer.add([this.overBtn, this.underBtn])

    this.overText = this.add.text(overX, btnY, 'OVER', {
      fontSize: `${Math.round(Math.min(W * 0.045, 18))}px`,
      fontFamily: 'Arial, sans-serif', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5)
    this.underText = this.add.text(underX, btnY, 'UNDER', {
      fontSize: `${Math.round(Math.min(W * 0.045, 18))}px`,
      fontFamily: 'Arial, sans-serif', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5)
    this.rootContainer.add([this.overText, this.underText])

    this.drawDirectionButtons(overX, underX, btnY, btnWidth, btnHeight)

    const overHit = this.add.rectangle(overX, btnY, btnWidth, btnHeight)
      .setInteractive({ useHandCursor: true })
    const underHit = this.add.rectangle(underX, btnY, btnWidth, btnHeight)
      .setInteractive({ useHandCursor: true })
    this.rootContainer.add([overHit, underHit])

    overHit.on('pointerdown', () => {
      if (this.direction === 'OVER') return
      this.direction = 'OVER'
      this.drawDirectionButtons(overX, underX, btnY, btnWidth, btnHeight)
      this.drawSlider()
      this.updateStats()
      this.sound.play('select', { volume: 0.5 })
    })

    underHit.on('pointerdown', () => {
      if (this.direction === 'UNDER') return
      this.direction = 'UNDER'
      this.drawDirectionButtons(overX, underX, btnY, btnWidth, btnHeight)
      this.drawSlider()
      this.updateStats()
      this.sound.play('select', { volume: 0.5 })
    })
  }

  private drawDirectionButtons(overX: number, underX: number, btnY: number, btnWidth: number, btnHeight: number) {
    this.overBtn.clear()
    if (this.direction === 'OVER') {
      this.overBtn.fillStyle(WIN_COLOR, 1)
      this.overText.setColor('#05001A')
    } else {
      this.overBtn.fillStyle(0x0D0A2E, 1)
      this.overBtn.lineStyle(2, ACCENT, 0.6)
      this.overText.setColor('#4B6EF5')
    }
    this.overBtn.fillRoundedRect(overX - btnWidth / 2, btnY - btnHeight / 2, btnWidth, btnHeight, 25)
    if (this.direction !== 'OVER') {
      this.overBtn.strokeRoundedRect(overX - btnWidth / 2, btnY - btnHeight / 2, btnWidth, btnHeight, 25)
    }

    this.underBtn.clear()
    if (this.direction === 'UNDER') {
      this.underBtn.fillStyle(LOSE_COLOR, 1)
      this.underText.setColor('#ffffff')
    } else {
      this.underBtn.fillStyle(0x0D0A2E, 1)
      this.underBtn.lineStyle(2, ACCENT, 0.6)
      this.underText.setColor('#4B6EF5')
    }
    this.underBtn.fillRoundedRect(underX - btnWidth / 2, btnY - btnHeight / 2, btnWidth, btnHeight, 25)
    if (this.direction !== 'UNDER') {
      this.underBtn.strokeRoundedRect(underX - btnWidth / 2, btnY - btnHeight / 2, btnWidth, btnHeight, 25)
    }
  }

  private updateStats() {
    const winChance  = this.direction === 'OVER'
      ? (100 - this.threshold) / 100
      : this.threshold / 100
    const multiplier = parseFloat((0.90 / winChance).toFixed(4))
    this.multiplierText.setText(`${multiplier.toFixed(2)}×`)
    this.winChanceText.setText(`Win: ${(winChance * 100).toFixed(2)}%`)
    this.thresholdText.setText(String(this.threshold))
    this.sendPickSelected()
  }

  private sendPickSelected() {
    const winChance  = this.direction === 'OVER'
      ? (100 - this.threshold) / 100
      : this.threshold / 100
    const multiplier = parseFloat((0.90 / winChance).toFixed(4))
    window.parent.postMessage({
      type: 'PICK_SELECTED',
      payload: {
        pick: `${this.direction} ${this.threshold}`,
        threshold: this.threshold,
        direction: this.direction,
        multiplier,
      }
    }, this.PARENT_ORIGIN)
  }

  public placeBet() {
    if (this.isPlacing || !this.isAuthenticated) return
    if (this.currentBalance < this.currentStake) {
      this.showError('Insufficient balance')
      return
    }
    this.isPlacing = true
    this.sound.play('click', { volume: 0.6 })

    this.rollSound = this.sound.add('roll')
    this.rollSound.play({ volume: 0.3, loop: false })

    const clientSeed = Math.random().toString(36).substring(2)
    this.bridge.placeBet({
      game: 'OLM_DICE',
      stake: this.currentStake,
      gameParams: { threshold: this.threshold, direction: this.direction },
      clientSeed,
    })
  }

  private handleResult(result: BetResult) {
    const roll   = (result.result as { roll: number }).roll
    const win    = result.win
    const payout = result.payout
    const newBal = result.newBalance

    const ctx = (this.sound as any).context
    if (ctx?.state === 'suspended') ctx.resume()
    if (this.rollSound?.isPlaying) this.rollSound.stop()

    // Subtle wobble while values tick — sells the "rolling" feel.
    this.tweens.add({
      targets: this.diceContainer, angle: { from: -6, to: 6 },
      duration: 90, yoyo: true, repeat: 8, ease: 'Sine.easeInOut',
    })

    const totalTicks = 12
    const delays = Array.from({ length: totalTicks }, (_, i) =>
      Math.round(800 / totalTicks * (i + 1))
    )

    delays.forEach((delay, i) => {
      this.time.delayedCall(delay, () => {
        if (i < totalTicks - 1) {
          const rand = (Math.random() * 100).toFixed(2)
          this.diceValueText.setText(rand)
          this.rollResultText.setText(rand)
          return
        }

        // Final reveal
        this.diceContainer.setAngle(0)
        this.diceValueText.setText(roll.toFixed(2))
        this.rollResultText.setText(roll.toFixed(2))

        const rounded = Math.round(roll)
        if (rounded >= 1 && rounded <= 6) this.showDiceDots(rounded)

        if (win) {
          this.drawDiceFace(0x001a00, WIN_COLOR)
          this.sound.play('win', { volume: 0.8 })
          this.cameras.main.flash(300, 0, 230, 118)
          this.tweens.add({
            targets: this.diceContainer, scaleX: 1.15, scaleY: 1.15,
            duration: 150, yoyo: true, ease: 'Back.easeOut',
          })
        } else {
          this.drawDiceFace(0x1a0000, LOSE_COLOR)
          this.sound.play('loss', { volume: 0.7 })
          this.cameras.main.shake(250, 0.006)
        }

        const flash = this.add.graphics().setDepth(20)
        flash.fillStyle(win ? WIN_COLOR : LOSE_COLOR, 0.15)
        flash.fillRect(0, 0, this.scale.width, this.scale.height)
        this.tweens.add({
          targets: flash, alpha: 0, duration: 350,
          onComplete: () => flash.destroy(),
        })

        this.showResultOverlay(win, roll, payout, newBal)
      })
    })
  }

  private createDice(cx: number, diceY: number) {
    this.diceContainer = this.add.container(cx, diceY)
    this.rootContainer.add(this.diceContainer)

    this.diceGlow = this.add.graphics()
    this.diceGlow.fillStyle(ACCENT_GLOW, 0.20)
    this.diceGlow.fillCircle(0, 0, this.diceSize * 0.75)
    this.diceGlow.fillStyle(ACCENT, 0.12)
    this.diceGlow.fillCircle(0, 0, this.diceSize * 0.95)

    this.diceGraphic = this.add.graphics()
    this.drawDiceFace(0x1a0a4a, ACCENT)

    this.diceValueText = this.add.text(0, 0, '?', {
      fontSize: `${Math.floor(this.diceSize * 0.35)}px`,
      fontFamily: 'Arial, sans-serif', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5)

    this.diceContainer.add([this.diceGlow, this.diceGraphic, this.diceValueText])

    this.tweens.add({
      targets: this.diceGlow, alpha: { from: 0.6, to: 1 },
      duration: 1200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    })
  }

  // Redraws just the dice face using this.diceSize, so every call site
  // (create, win, loss, reset) stays in sync instead of each hardcoding
  // its own Math.min(W * 0.35, 140).
  private drawDiceFace(fillColor: number, borderColor: number) {
    const s = this.diceSize
    this.diceGraphic.clear()
    this.diceGraphic.fillStyle(fillColor, 1)
    this.diceGraphic.fillRoundedRect(-s / 2, -s / 2, s, s, 15)
    this.diceGraphic.fillStyle(0xFFFFFF, 0.08)
    this.diceGraphic.fillRoundedRect(-s / 2, -s / 2, s, s * 0.4, 15)
    this.diceGraphic.lineStyle(3, borderColor, 1)
    this.diceGraphic.strokeRoundedRect(-s / 2, -s / 2, s, s, 15)
  }

  private showDiceDots(value: number) {
    const children = this.diceContainer.list.filter(
      child => child instanceof Phaser.GameObjects.Graphics
        && child !== this.diceGraphic && child !== this.diceGlow
    )
    children.forEach(child => (child as Phaser.GameObjects.Graphics).destroy())

    const dotSize = this.diceSize * 0.09
    const pad     = this.diceSize * 0.22

    const dot = (x: number, y: number) => {
      const g = this.add.graphics()
      g.fillStyle(0xFFFFFF, 1)
      g.fillCircle(x, y, dotSize)
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

  private showResultOverlay(win: boolean, roll: number, payout: number, newBalance: number) {
    const W  = this.scale.width
    const H  = this.scale.height
    const cx = this.cx

    this.overlay.clear()
    this.overlay.fillStyle(win ? 0x001a00 : 0x1a0000, 0.92)
    this.overlay.fillRect(0, 0, W, H)
    this.overlay.setVisible(true)

    this.overlayText
      .setText(win ? '🎲 WIN!' : 'MISS')
      .setColor(win ? '#FFD700' : '#FF3A2D')
      .setVisible(true).setScale(0.5).setAlpha(1)

    this.tweens.add({ targets: this.overlayText, scale: 1, duration: 300, ease: 'Back.easeOut' })

    this.overlaySubText
      .setText(win
        ? `₦${payout.toLocaleString()} · Roll: ${roll.toFixed(2)}`
        : `Rolled ${roll.toFixed(2)} · Better luck next time`)
      .setVisible(true).setAlpha(0)

    this.tweens.add({ targets: this.overlaySubText, alpha: 1, duration: 400, delay: 250 })

    if (win) {
      for (let i = 0; i < 28; i++) {
        const p = this.add.graphics().setDepth(12)
        const colors = [0xFFD700, WIN_COLOR, ACCENT, 0xFFFFFF, ACCENT_GLOW]
        p.fillStyle(colors[Math.floor(Math.random() * colors.length)], 1)
        p.fillCircle(0, 0, 2 + Math.random() * 4)
        p.setPosition(cx, H * 0.4)
        const angle = Math.random() * Math.PI * 2
        const dist  = 60 + Math.random() * 180
        this.tweens.add({
          targets: p,
          x: cx + Math.cos(angle) * dist,
          y: H * 0.4 + Math.sin(angle) * dist,
          alpha: 0, scale: 0.2,
          duration: 800 + Math.random() * 500,
          ease: 'Power2',
          onComplete: () => p.destroy(),
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

          this.drawDiceFace(0x1a0a4a, ACCENT)
          this.diceValueText.setText('?').setColor('#ffffff')
          this.rollResultText.setText('')

          const dots = this.diceContainer.list.filter(
            c => c instanceof Phaser.GameObjects.Graphics
              && c !== this.diceGraphic && c !== this.diceGlow
          )
          dots.forEach(d => (d as Phaser.GameObjects.Graphics).destroy())

          this.currentBalance = newBalance
          this.isPlacing = false

          window.parent.postMessage({
            type: 'BET_DONE',
            payload: { newBalance },
          }, this.PARENT_ORIGIN)
        },
      })
    })
  }

  private showError(message: string) {
    const err = this.add.text(
      this.scale.width / 2, 80, message, {
        fontSize: '13px',
        color: '#ff4444',
        backgroundColor: '#1a0000',
        padding: { x: 12, y: 8 },
      }
    ).setOrigin(0.5).setDepth(20)
    this.time.delayedCall(3000, () => err.destroy())
  }

  update(_time: number, delta: number) {
    this.auroraTime += delta * 0.001

    const W = this.scale.width
    const H = this.scale.height

    this.aurora1.clear()
    this.aurora1.fillStyle(ACCENT, 0.04)
    this.aurora1.fillEllipse(
      W * 0.3 + Math.sin(this.auroraTime * 0.5) * W * 0.2,
      H * 0.4 + Math.cos(this.auroraTime * 0.3) * H * 0.2,
      W * 0.6, H * 0.4
    )

    this.aurora2.clear()
    this.aurora2.fillStyle(0x0000FF, 0.03)
    this.aurora2.fillEllipse(
      W * 0.7 + Math.cos(this.auroraTime * 0.4) * W * 0.25,
      H * 0.6 + Math.sin(this.auroraTime * 0.6) * H * 0.25,
      W * 0.5, H * 0.35
    )
  }
}