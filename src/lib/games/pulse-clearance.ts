import * as THREE from "three";
import { clamp } from "./math";
import { installLook, type LookKit } from "./look";
import { sound } from "./audio";
import { PULSE_LEVELS, loadGameProgress, saveGameLevelResult, type LevelConfig, type EnemyType } from "./levels";
import type { GameContext, MiniGame, WeaponType, RadarDot } from "./types";

interface Enemy {
  root: THREE.Group;
  core: THREE.Mesh;
  type: EnemyType;
  hp: number;
  maxHp: number;
  speed: number;
  flash: number;
  bob: number;
  stunTimer: number;
  shieldMesh?: THREE.Mesh;
  laserGuide?: THREE.Line;
  sniperCharge?: number;
  isBoss?: boolean;
  bossPhase?: number;
  bossAttackTimer?: number;
  orbitDrones?: THREE.Mesh[];
}

interface Projectile {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  damage: number;
  isEnemy?: boolean;
  piercing?: boolean;
}

interface PowerUp {
  mesh: THREE.Group;
  type: "shield" | "overdrive" | "heal";
  life: number;
}

interface LaserTrap {
  group: THREE.Group;
  beam: THREE.Mesh;
  angle: number;
  speed: number;
}

export class PulseClearanceGame implements MiniGame {
  private ctx!: GameContext;
  private currentLevelIndex = 0;
  private currentLevel!: LevelConfig;
  private yaw = 0;
  private pitch = -0.06;

  // 玩家机体属性
  private hp = 100;
  private hpMax = 100;
  private shield = 50;
  private shieldMax = 50;
  private score = 0;
  private kills = 0;
  private wave = 1;
  private timeSec = 0;

  // 武器与技能
  private currentWeapon: WeaponType = "pulse";
  private shootCooldown = 0;
  private empCooldown = 0;
  private readonly empMaxCooldown = 15;
  private overdriveTimer = 0;

  // 连击系统
  private combo = 0;
  private comboTimer = 0;

  // 运行状态
  private status: "ready" | "playing" | "paused" | "won" | "lost" = "ready";
  private pos = new THREE.Vector3(0, 1.62, 8.4);
  private vel = new THREE.Vector3();
  private look!: LookKit;
  private live = false;

  // 游戏世界实体容器
  private arenaGroup = new THREE.Group();
  private enemies: Enemy[] = [];
  private projectiles: Projectile[] = [];
  private powerUps: PowerUp[] = [];
  private laserTraps: LaserTrap[] = [];
  private gunRoot = new THREE.Group();
  private muzzleLight!: THREE.PointLight;
  private gunModelPulse = new THREE.Group();
  private gunModelShotgun = new THREE.Group();
  private gunModelRailgun = new THREE.Group();

  // 动画与后坐力震颤
  private recoil = 0;
  private cameraShake = 0;
  private walkCycle = 0;
  private spawnTimer = 0;
  private spawnCount = 0;
  private waveCleared = false;
  private betweenWaveTimer = 0;

  mount(ctx: GameContext) {
    this.ctx = ctx;
    const { scene, camera } = ctx.engine;
    this.look = installLook(ctx.engine, { accent: 0x22d3ee, bg: 0x07111e });
    scene.add(camera);
    camera.fov = 70;
    camera.near = 0.05;
    camera.far = 120;
    camera.updateProjectionMatrix();
    camera.rotation.order = "YXZ";

    scene.add(this.arenaGroup);
    this.buildGunModels(camera);

    this.loadLevel(1);
    this.emitCurrentHud("ready");
  }

  selectLevel(levelId: number) {
    const targetIdx = PULSE_LEVELS.findIndex((l) => l.id === levelId);
    if (targetIdx !== -1) {
      this.loadLevel(levelId);
      this.start();
    }
  }

  private loadLevel(levelId: number) {
    this.currentLevelIndex = PULSE_LEVELS.findIndex((l) => l.id === levelId);
    if (this.currentLevelIndex === -1) this.currentLevelIndex = 0;
    this.currentLevel = PULSE_LEVELS[this.currentLevelIndex];

    this.clearWorld();
    this.buildArena();
    this.emitCurrentHud(this.status);
  }

  start() {
    sound.ensureContext();
    sound.startBgm();
    sound.setIntensity(this.currentLevel.hasBoss ? "boss" : "battle");

    this.live = true;
    this.status = "playing";
    this.yaw = 0;
    this.pitch = -0.06;
    this.hp = this.hpMax;
    this.shield = this.shieldMax;
    this.score = 0;
    this.kills = 0;
    this.wave = 1;
    this.timeSec = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.empCooldown = 0;
    this.overdriveTimer = 0;
    this.vel.set(0, 0, 0);
    this.pos.set(0, 1.62, this.currentLevel.arenaRadius * 0.55);

    this.clearWorld();
    this.buildArena();
    this.startWave(1);

    this.ctx.engine.setPointerLock(true);
    this.layoutCamera();
    this.emitCurrentHud("playing", `第 ${this.currentLevel.id} 关: ${this.currentLevel.name}`);
  }

  pause() {
    this.ctx.engine.setPointerLock(false);
    sound.stopBgm();
  }

  resume() {
    this.ctx.engine.setPointerLock(true);
    sound.startBgm();
  }

  dispose() {
    sound.stopBgm();
    this.clearWorld();
    const { scene, camera } = this.ctx.engine;
    scene.remove(this.arenaGroup);
    camera.remove(this.gunRoot);
  }

  private clearWorld() {
    // 销毁场景实体
    while (this.arenaGroup.children.length > 0) {
      const obj = this.arenaGroup.children[0];
      this.arenaGroup.remove(obj);
      if (obj instanceof THREE.Mesh) {
        obj.geometry?.dispose();
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material?.dispose();
      }
    }
    this.enemies = [];
    this.projectiles = [];
    this.powerUps = [];
    this.laserTraps = [];
  }

  // ==========================
  // 1. 动态赛博竞技场搭建
  // ==========================
  private buildArena() {
    const { scene } = this.ctx.engine;
    const { arenaRadius, theme, hasLaserTraps } = this.currentLevel;

    scene.background = new THREE.Color(theme.bg);
    scene.fog = new THREE.Fog(theme.bg, theme.fogNear, theme.fogFar);

    // 1. 赛博网格地面
    const floorCanvas = document.createElement("canvas");
    floorCanvas.width = floorCanvas.height = 1024;
    const g = floorCanvas.getContext("2d");
    if (g) {
      g.fillStyle = "#060c14";
      g.fillRect(0, 0, 1024, 1024);
      g.strokeStyle = "#0e2238";
      g.lineWidth = 3;
      for (let x = 0; x <= 1024; x += 128) {
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 1024); g.stroke();
        g.beginPath(); g.moveTo(0, x); g.lineTo(1024, x); g.stroke();
      }
      g.strokeStyle = `rgba(${(theme.accent >> 16) & 255}, ${(theme.accent >> 8) & 255}, ${theme.accent & 255}, 0.35)`;
      g.lineWidth = 1.5;
      for (let x = 0; x <= 1024; x += 32) {
        g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 1024); g.stroke();
        g.beginPath(); g.moveTo(0, x); g.lineTo(1024, x); g.stroke();
      }
    }
    const floorTex = new THREE.CanvasTexture(floorCanvas);
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(arenaRadius / 3, arenaRadius / 3);

    const floorGeo = new THREE.CylinderGeometry(arenaRadius, arenaRadius, 0.4, 32);
    const floorMat = new THREE.MeshStandardMaterial({
      map: floorTex,
      roughness: 0.25,
      metalness: 0.65,
    });
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.position.y = -0.2;
    floorMesh.receiveShadow = true;
    this.arenaGroup.add(floorMesh);

    // 2. 环形能量外壁
    const wallGeo = new THREE.CylinderGeometry(arenaRadius, arenaRadius, 5.5, 32, 1, true);
    const wallMat = new THREE.MeshStandardMaterial({
      color: theme.wall,
      emissive: theme.accent,
      emissiveIntensity: 0.35,
      roughness: 0.4,
      metalness: 0.7,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.85,
    });
    const wallMesh = new THREE.Mesh(wallGeo, wallMat);
    wallMesh.position.y = 2.75;
    this.arenaGroup.add(wallMesh);

    // 3. 掩体立柱 (Pylons) 产生战术掩护与阴影
    const pylonGeo = new THREE.BoxGeometry(2.4, 4.5, 2.4);
    const pylonMat = new THREE.MeshStandardMaterial({
      color: 0x0c1b2b,
      emissive: theme.accent,
      emissiveIntensity: 0.15,
      roughness: 0.3,
      metalness: 0.8,
    });
    const pylonCount = 5;
    for (let i = 0; i < pylonCount; i++) {
      const angle = (i / pylonCount) * Math.PI * 2;
      const dist = arenaRadius * 0.52;
      const pylon = new THREE.Mesh(pylonGeo, pylonMat);
      pylon.position.set(Math.cos(angle) * dist, 2.25, Math.sin(angle) * dist);
      pylon.castShadow = true;
      pylon.receiveShadow = true;
      this.arenaGroup.add(pylon);
    }

    // 4. 若关卡配置了旋转激光陷阱
    if (hasLaserTraps) {
      const trapGroup = new THREE.Group();
      trapGroup.position.set(0, 1.2, 0);
      const laserGeo = new THREE.CylinderGeometry(0.08, 0.08, arenaRadius * 1.8, 8);
      const laserMat = new THREE.MeshStandardMaterial({
        color: 0xff0044,
        emissive: 0xff0044,
        emissiveIntensity: 2.2,
      });
      const laserMesh = new THREE.Mesh(laserGeo, laserMat);
      laserMesh.rotation.z = Math.PI / 2;
      trapGroup.add(laserMesh);

      this.arenaGroup.add(trapGroup);
      this.laserTraps.push({
        group: trapGroup,
        beam: laserMesh,
        angle: 0,
        speed: 0.8,
      });
    }
  }

  // ==========================
  // 2. 武器模型与三武器切换
  // ==========================
  private buildGunModels(camera: THREE.Camera) {
    this.gunRoot.position.set(0.36, -0.32, -0.65);
    camera.add(this.gunRoot);

    // 枪口点光源
    this.muzzleLight = new THREE.PointLight(0x22d3ee, 0, 8);
    this.muzzleLight.position.set(0, 0.05, -0.5);
    this.gunRoot.add(this.muzzleLight);

    // 武器 1: 脉冲冲锋枪 (Cyan)
    const pBody = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.16, 0.55), new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.85, roughness: 0.2 }));
    const pBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.35, 8), new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x22d3ee, emissiveIntensity: 0.8 }));
    pBarrel.rotation.x = Math.PI / 2;
    pBarrel.position.set(0, 0.02, -0.35);
    pBody.castShadow = true;
    this.gunModelPulse.add(pBody, pBarrel);
    this.gunRoot.add(this.gunModelPulse);

    // 武器 2: 等离子霰弹枪 (Amber)
    const sBody = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.18, 0.48), new THREE.MeshStandardMaterial({ color: 0x1c1917, metalness: 0.9, roughness: 0.3 }));
    const sBarrel1 = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.28, 8), new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xf59e0b, emissiveIntensity: 0.8 }));
    sBarrel1.rotation.x = Math.PI / 2;
    sBarrel1.position.set(-0.04, 0.02, -0.3);
    const sBarrel2 = sBarrel1.clone();
    sBarrel2.position.x = 0.04;
    this.gunModelShotgun.add(sBody, sBarrel1, sBarrel2);
    this.gunModelShotgun.visible = false;
    this.gunRoot.add(this.gunModelShotgun);

    // 武器 3: 离子轨道炮 (Violet / Pink)
    const rBody = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.22, 0.75), new THREE.MeshStandardMaterial({ color: 0x180d2b, metalness: 0.95, roughness: 0.1 }));
    const rCoil = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.02, 8, 16), new THREE.MeshStandardMaterial({ color: 0xa855f7, emissive: 0xa855f7, emissiveIntensity: 1.2 }));
    rCoil.position.set(0, 0.02, -0.25);
    this.gunModelRailgun.add(rBody, rCoil);
    this.gunModelRailgun.visible = false;
    this.gunRoot.add(this.gunModelRailgun);
  }

  private switchWeapon(slot: WeaponType) {
    if (this.currentWeapon === slot) return;
    this.currentWeapon = slot;
    this.gunModelPulse.visible = slot === "pulse";
    this.gunModelShotgun.visible = slot === "shotgun";
    this.gunModelRailgun.visible = slot === "railgun";

    sound.playHit();
    this.emitCurrentHud("playing", `装备切换: ${slot.toUpperCase()}`);
  }

  // ==========================
  // 3. 核心战斗循环与更新
  // ==========================
  update(dt: number) {
    if (this.status !== "playing") return;
    const engine = this.ctx.engine;
    this.timeSec += dt;

    // 1. 处理鼠标瞄准与视角
    this.yaw -= engine.mouseDx * 0.00205;
    this.pitch -= engine.mouseDy * 0.00205;
    this.pitch = clamp(this.pitch, -1.2, 1.2);

    // 2. 武器按键切换 (1 / 2 / 3)
    const weaponKey = engine.weaponSlotPressed();
    if (weaponKey === 1) this.switchWeapon("pulse");
    if (weaponKey === 2) this.switchWeapon("shotgun");
    if (weaponKey === 3) this.switchWeapon("railgun");

    // 3. 释放全向 EMP 战术技能 (E 键)
    if (engine.skillEmpPressed() && this.empCooldown <= 0) {
      this.triggerEmpBlast();
    }
    this.empCooldown = Math.max(0, this.empCooldown - dt);

    // 4. 移动与冲刺物理
    const axis = engine.axis();
    const sprint = engine.sprintHeld();
    const maxSpeed = sprint ? 12.5 : 8.0;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const wish = new THREE.Vector3(axis.y * sin + axis.x * cos, 0, axis.y * cos - axis.x * sin);
    if (wish.lengthSq() > 1) wish.normalize();

    this.vel.x += wish.x * 45 * dt;
    this.vel.z += wish.z * 45 * dt;
    this.vel.x *= Math.exp(-8 * dt);
    this.vel.z *= Math.exp(-8 * dt);

    const speed = Math.hypot(this.vel.x, this.vel.z);
    if (speed > maxSpeed) {
      this.vel.x *= maxSpeed / speed;
      this.vel.z *= maxSpeed / speed;
    }

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;

    // 限制在竞技场圆盘内
    const r = Math.hypot(this.pos.x, this.pos.z);
    const limit = this.currentLevel.arenaRadius - 1.2;
    if (r > limit) {
      this.pos.x = (this.pos.x / r) * limit;
      this.pos.z = (this.pos.z / r) * limit;
    }

    const moving = Math.hypot(wish.x, wish.z) > 0.1;
    this.walkCycle += dt * (moving ? (sprint ? 14 : 10) : 0);
    this.layoutCamera();

    // 5. 枪口震动与开火
    this.shootCooldown = Math.max(0, this.shootCooldown - dt);
    this.recoil = Math.max(0, this.recoil - dt * 9);
    this.cameraShake = Math.max(0, this.cameraShake - dt * 6);
    this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 25);
    this.overdriveTimer = Math.max(0, this.overdriveTimer - dt);

    if ((engine.firePressed() || engine.fireHeld()) && this.shootCooldown <= 0) {
      this.executeFire();
    }

    // 6. 连击计时器更新
    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) {
        this.combo = 0;
      }
    }

    // 7. 更新敌人生成与战斗波次
    this.updateWaves(dt);

    // 8. 更新飞行物、能量球与敌人
    this.updateProjectiles(dt);
    this.updatePowerUps(dt);
    this.updateEnemies(dt);
    this.updateLaserTraps(dt);

    // 9. 刷新雷达与 HUD
    this.emitCurrentHud("playing");
  }

  // ==========================
  // 4. 射击与弹道物理实现
  // ==========================
  private executeFire() {
    const { camera } = this.ctx.engine;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    const damageMult = this.overdriveTimer > 0 ? 2.0 : 1.0;

    this.recoil = 0.12;
    this.cameraShake = 0.08;
    this.muzzleLight.intensity = 3.5;

    if (this.currentWeapon === "pulse") {
      this.shootCooldown = 0.09;
      sound.playPulseShoot();
      this.spawnBullet(forward, 26 * damageMult, 65, 0x22d3ee);
    } else if (this.currentWeapon === "shotgun") {
      this.shootCooldown = 0.55;
      this.cameraShake = 0.22;
      this.recoil = 0.25;
      sound.playShotgunShoot();
      // 8 枚扇形弹丸
      for (let i = 0; i < 8; i++) {
        const spread = forward.clone().add(new THREE.Vector3(
          (Math.random() - 0.5) * 0.14,
          (Math.random() - 0.5) * 0.14,
          (Math.random() - 0.5) * 0.14
        )).normalize();
        this.spawnBullet(spread, 16 * damageMult, 55, 0xf59e0b);
      }
    } else if (this.currentWeapon === "railgun") {
      this.shootCooldown = 0.95;
      this.cameraShake = 0.35;
      this.recoil = 0.38;
      sound.playRailgunShoot();
      // 穿透电磁射线
      this.spawnBullet(forward, 240 * damageMult, 120, 0xa855f7, true);
    }
  }

  private spawnBullet(dir: THREE.Vector3, damage: number, speed: number, color: number, piercing = false) {
    const geo = new THREE.CylinderGeometry(0.04, 0.04, piercing ? 1.8 : 0.45, 6);
    const mat = new THREE.MeshBasicMaterial({ color });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);

    // 枪口偏置起始点
    const origin = this.pos.clone().add(new THREE.Vector3(0, -0.05, 0)).add(dir.clone().multiplyScalar(0.6));
    mesh.position.copy(origin);
    this.arenaGroup.add(mesh);

    this.projectiles.push({
      mesh,
      vel: dir.clone().multiplyScalar(speed),
      life: 2.2,
      damage,
      piercing,
    });
  }

  // ==========================
  // 5. 战术 EMP 全向脉冲技能
  // ==========================
  private triggerEmpBlast() {
    this.empCooldown = this.empMaxCooldown;
    sound.playEmpBlast();
    this.cameraShake = 0.45;

    // 清除全场敌方子弹
    this.projectiles = this.projectiles.filter((p) => {
      if (p.isEnemy) {
        this.arenaGroup.remove(p.mesh);
        return false;
      }
      return true;
    });

    // 瘫痪并击退周围所有敌人
    this.enemies.forEach((e) => {
      e.stunTimer = 3.8;
      e.hp -= 40;
      const pushDir = e.root.position.clone().sub(this.pos).normalize();
      e.root.position.add(pushDir.multiplyScalar(3.5));
    });

    this.emitCurrentHud("playing", "EMP 脉冲爆发！全场敌人瘫痪！");
  }

  // ==========================
  // 6. 实体循环与碰撞判定
  // ==========================
  private updateProjectiles(dt: number) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.life -= dt;
      p.mesh.position.addScaledVector(p.vel, dt);

      // 敌方子弹打玩家
      if (p.isEnemy) {
        if (p.mesh.position.distanceTo(this.pos) < 1.1) {
          this.takeDamage(p.damage);
          this.arenaGroup.remove(p.mesh);
          this.projectiles.splice(i, 1);
          continue;
        }
      } else {
        // 玩家子弹打敌人
        let hit = false;
        for (let j = this.enemies.length - 1; j >= 0; j--) {
          const e = this.enemies[j];
          const hitDist = e.isBoss ? 2.8 : 1.2;
          if (p.mesh.position.distanceTo(e.root.position) < hitDist) {
            // 判定护盾敌人正面格挡
            if (e.type === "shield" && !p.piercing) {
              const enemyForward = new THREE.Vector3(0, 0, 1).applyQuaternion(e.root.quaternion);
              const bulletDir = p.vel.clone().normalize();
              // 如果从正面对射
              if (enemyForward.dot(bulletDir) < -0.4) {
                sound.playShieldDeflect();
                this.ctx.emitHud({ hitFlash: true });
                hit = true;
                break;
              }
            }

            e.hp -= p.damage;
            e.flash = 0.15;
            sound.playHit();
            this.ctx.emitHud({ hitFlash: true });

            if (e.hp <= 0) {
              this.killEnemy(e, j);
            }

            if (!p.piercing) {
              hit = true;
              break;
            }
          }
        }
        if (hit && !p.piercing) {
          this.arenaGroup.remove(p.mesh);
          this.projectiles.splice(i, 1);
          continue;
        }
      }

      // 超时销毁
      if (p.life <= 0) {
        this.arenaGroup.remove(p.mesh);
        this.projectiles.splice(i, 1);
      }
    }
  }

  private killEnemy(e: Enemy, index: number) {
    sound.playExplosion(e.isBoss);
    this.arenaGroup.remove(e.root);
    this.enemies.splice(index, 1);
    this.kills++;

    // 连击累加
    this.combo++;
    this.comboTimer = 2.8;
    const comboMult = Math.min(8, 1 + Math.floor(this.combo / 2));
    this.score += (e.isBoss ? 1500 : 100) * comboMult;

    // 概率掉落能量球 (25%)
    if (Math.random() < 0.28 || e.isBoss) {
      this.spawnPowerUp(e.root.position);
    }
  }

  private spawnPowerUp(pos: THREE.Vector3) {
    const types: Array<"shield" | "overdrive" | "heal"> = ["shield", "overdrive", "heal"];
    const type = types[Math.floor(Math.random() * types.length)];
    const group = new THREE.Group();
    group.position.copy(pos);
    group.position.y = 0.8;

    const color = type === "shield" ? 0x22d3ee : type === "overdrive" ? 0xf43f5e : 0x10b981;
    const geo = new THREE.OctahedronGeometry(0.35);
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 1.5,
    });
    const mesh = new THREE.Mesh(geo, mat);
    group.add(mesh);
    this.arenaGroup.add(group);

    this.powerUps.push({ mesh: group, type, life: 12 });
  }

  private updatePowerUps(dt: number) {
    for (let i = this.powerUps.length - 1; i >= 0; i--) {
      const p = this.powerUps[i];
      p.life -= dt;
      p.mesh.rotation.y += dt * 2.5;
      p.mesh.position.y = 0.8 + Math.sin(this.timeSec * 3) * 0.15;

      // 玩家拾取
      if (p.mesh.position.distanceTo(this.pos) < 1.8) {
        sound.playPowerup();
        if (p.type === "shield") {
          this.shield = Math.min(this.shieldMax, this.shield + 25);
          this.ctx.emitHud({ toast: "+25 能量护盾充能！" });
        } else if (p.type === "heal") {
          this.hp = Math.min(this.hpMax, this.hp + 25);
          this.ctx.emitHud({ toast: "+25 纳米机体修复！" });
        } else if (p.type === "overdrive") {
          this.overdriveTimer = 8.0;
          this.ctx.emitHud({ toast: "⚡ 狂暴过载激活！双倍伤害 8 秒！" });
        }
        this.arenaGroup.remove(p.mesh);
        this.powerUps.splice(i, 1);
        continue;
      }

      if (p.life <= 0) {
        this.arenaGroup.remove(p.mesh);
        this.powerUps.splice(i, 1);
      }
    }
  }

  private updateEnemies(dt: number) {
    this.enemies.forEach((e) => {
      // 闪烁受击复原
      if (e.flash > 0) {
        e.flash -= dt;
        (e.core.material as THREE.MeshStandardMaterial).emissiveIntensity = e.flash > 0 ? 3.0 : 0.85;
      }

      // EMP 瘫痪中
      if (e.stunTimer > 0) {
        e.stunTimer -= dt;
        return;
      }

      // 敌人朝向玩家
      const toPlayer = this.pos.clone().sub(e.root.position);
      toPlayer.y = 0;
      const dist = toPlayer.length();
      toPlayer.normalize();

      e.root.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), toPlayer);

      // 移动逻辑
      if (dist > (e.type === "sniper" ? 12 : 1.6)) {
        e.root.position.addScaledVector(toPlayer, e.speed * dt);
      }

      // 狙击手蓄力攻击
      if (e.type === "sniper") {
        e.sniperCharge = (e.sniperCharge || 0) + dt;
        if (e.sniperCharge >= 2.2) {
          e.sniperCharge = 0;
          this.spawnEnemyBullet(e.root.position, toPlayer, 28, 45);
        }
      }

      // BOSS 攻击机制
      if (e.isBoss) {
        e.bossAttackTimer = (e.bossAttackTimer || 0) + dt;
        if (e.bossAttackTimer >= 2.0) {
          e.bossAttackTimer = 0;
          // 环形三向弹幕
          for (let a = -0.3; a <= 0.3; a += 0.3) {
            const spreadDir = toPlayer.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
            this.spawnEnemyBullet(e.root.position, spreadDir, 20, 28);
          }
        }
      }

      // 近身撞击玩家
      if (dist < 1.4 && !e.isBoss) {
        this.takeDamage(12);
        e.hp = 0;
      }
    });

    // 过滤自爆的敌人
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (this.enemies[i].hp <= 0) {
        this.killEnemy(this.enemies[i], i);
      }
    }
  }

  private spawnEnemyBullet(pos: THREE.Vector3, dir: THREE.Vector3, damage: number, speed: number) {
    const geo = new THREE.SphereGeometry(0.18, 8, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xff0055 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos).add(new THREE.Vector3(0, 0.5, 0));
    this.arenaGroup.add(mesh);

    this.projectiles.push({
      mesh,
      vel: dir.clone().multiplyScalar(speed),
      life: 3.5,
      damage,
      isEnemy: true,
    });
  }

  private updateLaserTraps(dt: number) {
    this.laserTraps.forEach((trap) => {
      trap.angle += trap.speed * dt;
      trap.group.rotation.y = trap.angle;

      // 判定玩家是否穿过激光
      // 激光处于 Y=1.2 水平旋转，计算玩家到中心射线距离
      const playerDist = Math.hypot(this.pos.x, this.pos.z);
      if (playerDist < this.currentLevel.arenaRadius * 0.9) {
        const playerAngle = Math.atan2(this.pos.z, this.pos.x);
        const diff = Math.abs((playerAngle - trap.angle) % Math.PI);
        if (diff < 0.08 || diff > Math.PI - 0.08) {
          this.takeDamage(20 * dt);
        }
      }
    });
  }

  private takeDamage(amount: number) {
    // 护盾抵扣
    if (this.shield > 0) {
      sound.playShieldDeflect();
      if (this.shield >= amount) {
        this.shield -= amount;
        amount = 0;
      } else {
        amount -= this.shield;
        this.shield = 0;
      }
    }

    if (amount > 0) {
      this.hp = Math.max(0, this.hp - amount);
      this.cameraShake = 0.35;
      this.ctx.emitHud({ hurtFlash: true });

      if (this.hp <= 0) {
        this.handleDefeat();
      }
    }
  }

  // ==========================
  // 7. 波次调度与胜利判定
  // ==========================
  private startWave(w: number) {
    this.wave = w;
    this.waveCleared = false;
    this.spawnCount = Math.floor(this.currentLevel.targetKills / this.currentLevel.waves);
    this.spawnTimer = 0.5;

    // 如果是最后一波且有关卡 BOSS
    if (this.wave === this.currentLevel.waves && this.currentLevel.hasBoss) {
      this.spawnBoss();
      this.ctx.emitHud({ toast: "⚠️ 警告：检测到主宰级机械巨兽接近！" });
    } else {
      this.ctx.emitHud({ toast: `第 ${w} 波突袭已抵达` });
    }
  }

  private updateWaves(dt: number) {
    if (this.spawnCount > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnTimer = 0.65;
        this.spawnRandomEnemy();
        this.spawnCount--;
      }
    } else if (this.enemies.length === 0 && !this.waveCleared) {
      this.waveCleared = true;
      if (this.wave < this.currentLevel.waves) {
        this.betweenWaveTimer = 2.0;
      } else {
        this.handleVictory();
      }
    }

    if (this.waveCleared && this.wave < this.currentLevel.waves) {
      this.betweenWaveTimer -= dt;
      if (this.betweenWaveTimer <= 0) {
        this.startWave(this.wave + 1);
      }
    }
  }

  private spawnRandomEnemy() {
    const types = this.currentLevel.enemyPool.filter((t) => !t.startsWith("boss"));
    const type = types[Math.floor(Math.random() * types.length)] || "swarmer";
    const angle = Math.random() * Math.PI * 2;
    const dist = this.currentLevel.arenaRadius * 0.85;

    const pos = new THREE.Vector3(Math.cos(angle) * dist, 1.2, Math.sin(angle) * dist);
    this.createEnemy(type, pos);
  }

  private createEnemy(type: EnemyType, pos: THREE.Vector3) {
    const root = new THREE.Group();
    root.position.copy(pos);

    let coreGeo: THREE.BufferGeometry;
    let color = 0x22d3ee;
    let speed = 4.2;
    let hp = 60;

    if (type === "shield") {
      coreGeo = new THREE.BoxGeometry(1.0, 1.0, 1.0);
      color = 0x818cf8;
      speed = 2.8;
      hp = 140;

      // 前置防御护盾
      const shieldMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1.6, 1.4),
        new THREE.MeshStandardMaterial({
          color: 0x38bdf8,
          emissive: 0x38bdf8,
          emissiveIntensity: 1.8,
          transparent: true,
          opacity: 0.75,
          side: THREE.DoubleSide,
        })
      );
      shieldMesh.position.set(0, 0, 0.7);
      root.add(shieldMesh);
    } else if (type === "sniper") {
      coreGeo = new THREE.ConeGeometry(0.6, 1.4, 6);
      color = 0xf43f5e;
      speed = 1.8;
      hp = 80;
    } else {
      coreGeo = new THREE.OctahedronGeometry(0.6);
      color = 0x22d3ee;
      speed = 5.2;
      hp = 50;
    }

    const core = new THREE.Mesh(coreGeo, new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.85,
      metalness: 0.7,
      roughness: 0.3,
    }));
    core.castShadow = true;
    root.add(core);
    this.arenaGroup.add(root);

    this.enemies.push({
      root,
      core,
      type,
      hp,
      maxHp: hp,
      speed,
      flash: 0,
      bob: 0,
      stunTimer: 0,
    });
  }

  private spawnBoss() {
    const root = new THREE.Group();
    root.position.set(0, 3.5, -this.currentLevel.arenaRadius * 0.65);

    // 机械巨兽核心
    const coreGeo = new THREE.DodecahedronGeometry(2.4);
    const coreMat = new THREE.MeshStandardMaterial({
      color: 0x10b981,
      emissive: 0x10b981,
      emissiveIntensity: 1.5,
      roughness: 0.2,
      metalness: 0.85,
    });
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.castShadow = true;
    root.add(core);

    this.arenaGroup.add(root);

    const hp = this.currentLevel.bossType === "overlord" ? 3000 : 1500;
    this.enemies.push({
      root,
      core,
      type: this.currentLevel.bossType === "overlord" ? "boss_overlord" : "boss_colossus",
      hp,
      maxHp: hp,
      speed: 1.6,
      flash: 0,
      bob: 0,
      stunTimer: 0,
      isBoss: true,
      bossPhase: 1,
      bossAttackTimer: 0,
    });
  }

  private handleVictory() {
    this.status = "won";
    sound.stopBgm();
    sound.playVictory();
    this.ctx.engine.setPointerLock(false);

    const hpPercent = this.hp / this.hpMax;
    const result = saveGameLevelResult(
      "pulse-clearance",
      this.currentLevel.id,
      this.score,
      Math.round(this.timeSec),
      hpPercent
    );

    this.ctx.emitHud({
      status: "won",
      score: this.score,
      levelResult: {
        stars: result.stars,
        score: this.score,
        timeSec: Math.round(this.timeSec),
        isNewUnlock: result.isNewUnlock,
        nextLevelId: result.nextLevelId,
      },
      objective: "关卡全清！战役胜利！",
    });
  }

  private handleDefeat() {
    this.status = "lost";
    sound.stopBgm();
    this.ctx.engine.setPointerLock(false);
    this.ctx.emitHud({
      status: "lost",
      objective: "机体能源耗尽，战役失败",
      toast: "按 R 键重试当前关卡",
    });
  }

  // ==========================
  // 8. 视角与 HUD 数据同步
  // ==========================
  private layoutCamera() {
    const { camera } = this.ctx.engine;
    camera.position.copy(this.pos);
    camera.position.y += Math.sin(this.walkCycle) * 0.04;
    camera.position.x += Math.cos(this.walkCycle * 0.5) * 0.02;

    // 视角震颤
    if (this.cameraShake > 0) {
      camera.position.x += (Math.random() - 0.5) * this.cameraShake;
      camera.position.y += (Math.random() - 0.5) * this.cameraShake;
    }

    camera.rotation.y = this.yaw;
    camera.rotation.x = this.pitch - this.recoil;

    // 枪支位置跟随
    this.gunRoot.position.set(0.32, -0.28 + this.recoil * 0.5, -0.62 + this.recoil);
  }

  private emitCurrentHud(status: "ready" | "playing" | "paused" | "won" | "lost", toastMsg?: string) {
    // 计算雷达点
    const radarDots: RadarDot[] = this.enemies.map((e) => {
      const relX = (e.root.position.x - this.pos.x) / this.currentLevel.arenaRadius;
      const relZ = (e.root.position.z - this.pos.z) / this.currentLevel.arenaRadius;
      return {
        x: clamp(relX, -1, 1),
        y: clamp(-relZ, -1, 1),
        type: e.isBoss ? "boss" : e.type === "shield" ? "shield" : e.type === "sniper" ? "sniper" : "enemy",
      };
    });

    // 寻找当前场上的 BOSS
    const boss = this.enemies.find((e) => e.isBoss);

    this.ctx.emitHud({
      status,
      score: this.score,
      timeSec: Math.round(this.timeSec),
      levelId: this.currentLevel.id,
      levelName: this.currentLevel.name,
      levelTotal: PULSE_LEVELS.length,
      hp: Math.round(this.hp),
      hpMax: this.hpMax,
      shield: Math.round(this.shield),
      shieldMax: this.shieldMax,
      currentWeapon: this.currentWeapon,
      empCd: Math.round(this.empCooldown),
      empMaxCd: this.empMaxCooldown,
      combo: this.combo,
      comboBanner:
        this.combo >= 8
          ? "GODLIKE x8"
          : this.combo >= 6
          ? "UNSTOPPABLE x6"
          : this.combo >= 4
          ? "RAMPAGE x4"
          : this.combo >= 2
          ? "DOUBLE KILL"
          : undefined,
      bossName: boss ? this.currentLevel.name : undefined,
      bossHp: boss ? Math.round(boss.hp) : undefined,
      bossMaxHp: boss ? boss.maxHp : undefined,
      enemiesLeft: this.enemies.length + this.spawnCount,
      radarDots,
      toast: toastMsg,
    });
  }
}
