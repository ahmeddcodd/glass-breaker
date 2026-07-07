import type { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { FresnelParameters } from '@babylonjs/core/Materials/fresnelParameters';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Constants } from '@babylonjs/core/Engines/constants';

// ---------------------------------------------------------------------------
// Procedural textures — painted once on a canvas, zero asset files.
// Textures are near-neutral gray so each material's diffuseColor still tints.
// ---------------------------------------------------------------------------

/** Brushed metal plate: speckle noise, panel grid lines, corner rivets. */
function makePlateTexture(scene: Scene): DynamicTexture {
  const size = 256;
  const tex = new DynamicTexture('plateTex', size, scene, true);
  const c = tex.getContext() as CanvasRenderingContext2D;

  c.fillStyle = '#9aa6b2';
  c.fillRect(0, 0, size, size);

  // fine speckle grain
  for (let i = 0; i < 1400; i++) {
    c.fillStyle = Math.random() < 0.5 ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.05)';
    c.fillRect(Math.random() * size, Math.random() * size, 1 + Math.random() * 2, 1);
  }
  // horizontal brushing streaks
  for (let i = 0; i < 40; i++) {
    c.fillStyle = 'rgba(255,255,255,0.03)';
    c.fillRect(0, Math.random() * size, size, 1);
  }
  // panel grid with bevel highlight
  const cell = 64;
  for (let p = 0; p <= size; p += cell) {
    c.fillStyle = 'rgba(0,0,0,0.28)';
    c.fillRect(p, 0, 2, size);
    c.fillRect(0, p, size, 2);
    c.fillStyle = 'rgba(255,255,255,0.10)';
    c.fillRect(p + 2, 0, 1, size);
    c.fillRect(0, p + 2, size, 1);
  }
  // rivets near grid intersections
  for (let x = cell; x < size; x += cell) {
    for (let y = cell; y < size; y += cell) {
      c.fillStyle = 'rgba(0,0,0,0.35)';
      c.beginPath();
      c.arc(x + 8, y + 8, 3, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = 'rgba(255,255,255,0.25)';
      c.beginPath();
      c.arc(x + 7, y + 7, 1.2, 0, Math.PI * 2);
      c.fill();
    }
  }
  tex.update();
  return tex;
}

/** Faint diagonal streaks + smudges — sells glass as a real surface. */
function makeGlassTexture(scene: Scene): DynamicTexture {
  const size = 256;
  const tex = new DynamicTexture('glassTex', size, scene, true);
  const c = tex.getContext() as CanvasRenderingContext2D;

  c.fillStyle = '#cdd8e0';
  c.fillRect(0, 0, size, size);

  // diagonal light streaks
  c.save();
  c.translate(size / 2, size / 2);
  c.rotate(-0.5);
  for (let i = 0; i < 14; i++) {
    const w = 2 + Math.random() * 9;
    const x = -size + Math.random() * size * 2;
    c.fillStyle = `rgba(255,255,255,${(0.06 + Math.random() * 0.12).toFixed(2)})`;
    c.fillRect(x, -size, w, size * 2);
  }
  c.restore();

  // soft smudge blobs
  for (let i = 0; i < 10; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 18 + Math.random() * 42;
    const grad = c.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.07)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = grad;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }
  tex.update();
  return tex;
}

export interface GameMaterials {
  glass: StandardMaterial;
  glassCracked: StandardMaterial;
  reinforced: StandardMaterial;
  bonus: StandardMaterial;
  bonusCore: StandardMaterial;
  danger: StandardMaterial;
  dangerCore: StandardMaterial;
  power: StandardMaterial;
  powerCore: StandardMaterial;
  metal: StandardMaterial;
  lattice: StandardMaterial;
  trail: StandardMaterial;
  strip: StandardMaterial;
  corridor: StandardMaterial;
  shard: StandardMaterial;
  spark: StandardMaterial;
  flash: StandardMaterial;
  portal: StandardMaterial;
}

function emissiveFresnel(edge: string, center: string, bias: number, power: number): FresnelParameters {
  const fp = new FresnelParameters();
  fp.leftColor = Color3.FromHexString(edge);
  fp.rightColor = Color3.FromHexString(center);
  fp.bias = bias;
  fp.power = power;
  return fp;
}

export function createMaterials(scene: Scene): GameMaterials {
  const plateTex = makePlateTexture(scene);
  const glassTex = makeGlassTexture(scene);

  // Premium glass: fresnel makes edges glow while the facing surface stays
  // transparent — the classic Babylon glass recipe, still one cheap shader.
  const glass = new StandardMaterial('glass', scene);
  glass.diffuseTexture = glassTex;
  glass.diffuseColor = Color3.FromHexString('#9fd8ff');
  glass.emissiveColor = Color3.FromHexString('#123048');
  glass.specularColor = Color3.FromHexString('#ffffff');
  glass.specularPower = 96;
  glass.alpha = 0.32;
  glass.backFaceCulling = false;
  glass.emissiveFresnelParameters = emissiveFresnel('#9fe4ff', '#0a2438', 0.18, 2.2);
  const glassOpacityFresnel = new FresnelParameters();
  glassOpacityFresnel.leftColor = Color3.White(); // opaque grazing edges
  glassOpacityFresnel.rightColor = Color3.FromHexString('#555555'); // see-through center
  glassOpacityFresnel.bias = 0.25;
  glassOpacityFresnel.power = 1.6;
  glass.opacityFresnelParameters = glassOpacityFresnel;

  const glassCracked = new StandardMaterial('glassCracked', scene);
  glassCracked.diffuseTexture = glassTex;
  glassCracked.diffuseColor = Color3.FromHexString('#d8f0ff');
  glassCracked.emissiveColor = Color3.FromHexString('#5c92b8');
  glassCracked.specularColor = Color3.FromHexString('#ffffff');
  glassCracked.specularPower = 48;
  glassCracked.alpha = 0.6;
  glassCracked.backFaceCulling = false;
  glassCracked.emissiveFresnelParameters = emissiveFresnel('#eaffff', '#3a6a8a', 0.3, 1.6);

  const reinforced = new StandardMaterial('reinforced', scene);
  reinforced.diffuseTexture = plateTex;
  reinforced.diffuseColor = Color3.FromHexString('#6fa3c8');
  reinforced.emissiveColor = Color3.FromHexString('#0e2233');
  reinforced.specularColor = Color3.FromHexString('#ffffff');
  reinforced.specularPower = 64;
  reinforced.alpha = 0.66;
  reinforced.backFaceCulling = false;
  reinforced.emissiveFresnelParameters = emissiveFresnel('#a8d4f0', '#0a1c2c', 0.22, 2);

  // Crystals: transparent outer shell + hot emissive inner core.
  const bonus = new StandardMaterial('bonus', scene);
  bonus.diffuseColor = Color3.FromHexString('#7dffd6');
  bonus.emissiveColor = Color3.FromHexString('#0f9c72');
  bonus.specularColor = Color3.FromHexString('#ffffff');
  bonus.alpha = 0.5;
  bonus.backFaceCulling = false;
  bonus.emissiveFresnelParameters = emissiveFresnel('#a8ffe6', '#0a5c44', 0.2, 2);

  const bonusCore = new StandardMaterial('bonusCore', scene);
  bonusCore.emissiveColor = Color3.FromHexString('#4dffc4');
  bonusCore.diffuseColor = Color3.Black();
  bonusCore.disableLighting = true;

  const danger = new StandardMaterial('danger', scene);
  danger.diffuseColor = Color3.FromHexString('#ff6070');
  danger.emissiveColor = Color3.FromHexString('#8c0a24');
  danger.specularColor = Color3.FromHexString('#ffffff');
  danger.alpha = 0.55;
  danger.backFaceCulling = false;
  danger.emissiveFresnelParameters = emissiveFresnel('#ff8a9a', '#5c0618', 0.2, 2);

  const dangerCore = new StandardMaterial('dangerCore', scene);
  dangerCore.emissiveColor = Color3.FromHexString('#ff2846');
  dangerCore.diffuseColor = Color3.Black();
  dangerCore.disableLighting = true;

  // Power-up pickups: unmistakable gold, distinct from every hazard color.
  const power = new StandardMaterial('power', scene);
  power.diffuseColor = Color3.FromHexString('#ffe28a');
  power.emissiveColor = Color3.FromHexString('#c89018');
  power.specularColor = Color3.FromHexString('#ffffff');
  power.alpha = 0.6;
  power.backFaceCulling = false;
  power.emissiveFresnelParameters = emissiveFresnel('#ffe9a8', '#7a5408', 0.2, 2);

  const powerCore = new StandardMaterial('powerCore', scene);
  powerCore.emissiveColor = Color3.FromHexString('#ffd24d');
  powerCore.diffuseColor = Color3.Black();
  powerCore.disableLighting = true;

  // Chrome projectile: bright fresnel rim reads as reflective metal.
  const metal = new StandardMaterial('metal', scene);
  metal.diffuseColor = Color3.FromHexString('#b8c8d8');
  metal.emissiveColor = Color3.FromHexString('#404e5c');
  metal.specularColor = Color3.FromHexString('#ffffff');
  metal.specularPower = 128;
  metal.emissiveFresnelParameters = emissiveFresnel('#e8f6ff', '#202c38', 0.3, 1.4);

  const lattice = new StandardMaterial('lattice', scene);
  lattice.diffuseTexture = plateTex;
  lattice.diffuseColor = Color3.FromHexString('#3c4e60');
  lattice.emissiveColor = Color3.FromHexString('#101d2a');
  lattice.specularColor = Color3.FromHexString('#c8dcec');
  lattice.specularPower = 64;

  const trail = new StandardMaterial('trail', scene);
  trail.emissiveColor = Color3.FromHexString('#b8f0ff');
  trail.diffuseColor = Color3.Black();
  trail.disableLighting = true;
  trail.alpha = 0.55;
  trail.alphaMode = Constants.ALPHA_ADD;

  // Shared accent for obstacle frames/hubs — tinted toward the zone color
  // by Corridor.applyZoneBlend each frame.
  const strip = new StandardMaterial('strip', scene);
  strip.emissiveColor = Color3.FromHexString('#3fd2ff');
  strip.diffuseColor = Color3.Black();
  strip.disableLighting = true;

  const corridor = new StandardMaterial('corridor', scene);
  corridor.diffuseTexture = plateTex;
  corridor.diffuseColor = Color3.FromHexString('#233850');
  corridor.specularColor = Color3.FromHexString('#243648');
  corridor.specularPower = 48;
  corridor.emissiveColor = Color3.FromHexString('#060d18');

  const shard = new StandardMaterial('shard', scene);
  shard.diffuseColor = Color3.White();
  shard.emissiveColor = Color3.FromHexString('#2a4658');
  shard.specularColor = Color3.FromHexString('#ffffff');
  shard.specularPower = 96;
  shard.backFaceCulling = false;

  const spark = new StandardMaterial('spark', scene);
  spark.emissiveColor = Color3.White();
  spark.diffuseColor = Color3.Black();
  spark.disableLighting = true;
  spark.alphaMode = Constants.ALPHA_ADD;
  spark.backFaceCulling = false;

  const flash = new StandardMaterial('flash', scene);
  flash.emissiveColor = Color3.FromHexString('#d6f4ff');
  flash.diffuseColor = Color3.Black();
  flash.disableLighting = true;
  flash.alpha = 0.85;
  flash.alphaMode = Constants.ALPHA_ADD;
  flash.backFaceCulling = false;

  const portal = new StandardMaterial('portal', scene);
  portal.emissiveColor = Color3.FromHexString('#5ad6ff');
  portal.diffuseColor = Color3.Black();
  portal.disableLighting = true;
  portal.alpha = 0.16;
  portal.alphaMode = Constants.ALPHA_ADD;
  portal.backFaceCulling = false;

  return {
    glass,
    glassCracked,
    reinforced,
    bonus,
    bonusCore,
    danger,
    dangerCore,
    power,
    powerCore,
    metal,
    lattice,
    trail,
    strip,
    corridor,
    shard,
    spark,
    flash,
    portal,
  };
}
