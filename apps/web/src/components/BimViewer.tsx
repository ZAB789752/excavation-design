import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { psetLabel, propertyLabel, propertyValue } from './bim-labels';
import './bim-viewer.css';

type Bucket = {
  pos: Float32Array[];
  nrm: Float32Array[];
  idx: Uint32Array[];
  // 每个顶点属于哪个 expressID。合并成一个 mesh 之后只能靠它反查构件，
  // 否则 20 MB 的模型点哪都是一整块。
  pid: Float32Array[];
  base: number;
};

const emptyBucket = (): Bucket => ({ pos: [], nrm: [], idx: [], pid: [], base: 0 });

type ViewMode = 'solid' | 'xray' | 'rebar';

const VIEW_MODES: { key: ViewMode; label: string; hint: string }[] = [
  { key: 'solid', label: '实体', hint: '混凝土不透明，只看外观' },
  { key: 'xray', label: '透视', hint: '混凝土半透明，钢筋笼可见' },
  { key: 'rebar', label: '只看钢筋', hint: '隐藏混凝土，完整查看钢筋' },
];

// 与 app/ifc/exporter.py 里三种 IfcSurfaceStyle 的 RGB 对应
const REBAR_LEGEND = [
  { color: '#b84333', label: '主筋' },
  { color: '#0d7394', label: '箍筋' },
  { color: '#d9991a', label: '加强箍' },
];

// 只翻译本项目真正会导出的类型，其余回落到 IFC 原名
// 键是去掉 Ifc 前缀的大写名：web-ifc 返回 "IfcPile" 这种写法。
const TYPE_LABELS: Record<string, string> = {
  PILE: '钻孔灌注桩',
  WALL: '地下连续墙',
  WALLSTANDARDCASE: '地下连续墙',
  BEAM: '冠梁 / 围檩',
  COLUMN: '立柱（临时柱）',
  SLAB: '顶板 / 底板',
  MEMBER: '支撑构件',
  REINFORCINGBAR: '钢筋',
  REINFORCINGMESH: '钢筋网',
  FOOTING: '基础',
};

type PickedRow = { name: string; raw: string; value: string };
type PickedGroup = { name: string; rows: PickedRow[] };
type Picked = {
  id: number;
  type: string;
  label: string;
  globalId: string;
  groups: PickedGroup[];
};

export default function BimViewer({ url, height = 420, autoPick }: {
  url: string;
  height?: number;
  // 仅用于出图/截图：加载完成后自动选中指定类型的第一个构件
  autoPick?: { type: string; index?: number };
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<{ loading: boolean; progress: number; message: string; error: string }>({
    loading: true, progress: 0, message: '准备中…', error: '',
  });
  // 混凝土不透明时会完整包住桩/墙/梁内的钢筋笼，导致导出再多钢筋也看不到。
  // 但默认不能是透视：226 根桩 × 18 根竖筋 = 4000 多条竖线，第一眼像一把钉耙。
  // 默认实体（看得到坑和构件），想看钢筋再切透视。
  const [viewMode, setViewMode] = useState<ViewMode>('solid');
  const modeRef = useRef<ViewMode>('solid');
  const applyModeRef = useRef<(mode: ViewMode) => void>(() => {});
  const concreteMeshRef = useRef<THREE.Mesh | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [section, setSection] = useState<number | null>(null);
  const sectionRef = useRef<number | null>(null);
  const applySectionRef = useRef<(value: number | null) => void>(() => {});
  const clearPickRef = useRef<() => void>(() => {});
  const cleanupPickRef = useRef<() => void>(() => {});

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf7fafc);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // 剖切要用到局部裁剪平面
    renderer.localClippingEnabled = true;
    // 中键在浏览器里会进入"自动滚动"，右键在某些外壳里被当成"后退"手势，
    // 两边都会和 OrbitControls 打架。在 pointerdown / mousedown / contextmenu
    // 上分别挡掉，不同浏览器触发这些默认行为的时机不一样。
    const blockNativeButtons = (event: MouseEvent | PointerEvent) => {
      if (event.button === 1 || event.button === 2) event.preventDefault();
    };
    const blockContextMenu = (event: MouseEvent) => event.preventDefault();
    const canvas = renderer.domElement;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', blockNativeButtons);
    canvas.addEventListener('mousedown', blockNativeButtons);
    canvas.addEventListener('contextmenu', blockContextMenu);

    host.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    // 缩放朝鼠标位置推进，而不是朝屏幕中心；平移/旋转给足速度，
    // 默认值在 60 m 的基坑上会觉得"推不动"。
    controls.zoomToCursor = true;
    controls.zoomSpeed = 1.1;
    controls.panSpeed = 1.4;
    controls.rotateSpeed = 0.85;
    // 鼠标约定：左键旋转、中键平移、滚轮推拉。右键整个禁用——
    // 它默认是 dolly，在浏览器外壳里还会触发"后退上一页"。
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: -1 as unknown as THREE.MOUSE,
    };
    // 屏幕空间平移：拖中键时模型跟着鼠标走，而不是沿地平面滑
    controls.screenSpacePanning = true;

    // 之前三盏灯合计 3.35 强度，钢筋的深色被推到接近纯白，分色完全失效
    scene.add(new THREE.HemisphereLight(0xffffff, 0x94a3b8, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(80, 120, 60);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.22);
    fill.position.set(-60, 40, -80);
    scene.add(fill);

    const root = new THREE.Group();
    // web-ifc 返回的 flatTransformation 里已经带了 Z-up → Y-up 的转换，
    // 这里再转 -90° 会把整个基坑立起来：坑变成一堵 40 m 高的墙，
    // 4000 多根竖筋朝上，看着就是一把钉耙。
    scene.add(root);

    const grid = new THREE.GridHelper(200, 40, 0xd7e0ea, 0xeef2f7);
    grid.position.y = -0.01;
    scene.add(grid);

    let disposed = false;
    let frame = 0;
    let api: { CloseModel: (id: number) => void } | null = null;
    let modelID = -1;

    const resize = () => {
      const width = host.clientWidth || 640;
      const h = host.clientHeight || height;
      // 第三个参数必须是 true：它负责把画布的 CSS 尺寸同步成容器尺寸。
      // 之前传 false，高分屏上画布被按 devicePixelRatio 放大后没有缩回去，
      // 右边和下面被裁掉一截，模型永远偏右下——看着像"歪了"。
      renderer.setSize(width, h);
      camera.aspect = width / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    const tick = () => {
      if (disposed) return;
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    tick();

    const buildGeometry = (bucket: Bucket) => {
      if (!bucket.pos.length) return null;
      const vertexCount = bucket.pos.reduce((sum, arr) => sum + arr.length, 0);
      const indexCount = bucket.idx.reduce((sum, arr) => sum + arr.length, 0);
      const positions = new Float32Array(vertexCount);
      const normals = new Float32Array(vertexCount);
      const pids = new Float32Array(vertexCount);
      const indices = new Uint32Array(indexCount);
      let po = 0;
      let io = 0;
      bucket.pos.forEach((arr) => { positions.set(arr, po); po += arr.length; });
      let no = 0;
      bucket.nrm.forEach((arr) => { normals.set(arr, no); no += arr.length; });
      let pio = 0;
      bucket.pid.forEach((arr) => { pids.set(arr, pio); pio += arr.length; });
      bucket.idx.forEach((arr) => { indices.set(arr, io); io += arr.length; });
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geometry.setAttribute('aPid', new THREE.BufferAttribute(pids, 1));
      geometry.setIndex(new THREE.BufferAttribute(indices, 1));
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      return geometry;
    };

    const run = async () => {
      try {
        setStatus({ loading: true, progress: 3, message: '加载 IFC 解析器…', error: '' });
        const ifc = await import('web-ifc');
        const ifcApi = new ifc.IfcAPI();
        ifcApi.SetWasmPath('/wasm/');
        await ifcApi.Init();
        if (disposed) return;

        setStatus({ loading: true, progress: 10, message: '下载模型文件…', error: '' });
        const response = await fetch(url);
        if (!response.ok) throw new Error(`模型下载失败：HTTP ${response.status}`);
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (disposed) return;

        setStatus({ loading: true, progress: 22, message: `解析 IFC（${(buffer.byteLength / 1048576).toFixed(1)} MB）…`, error: '' });
        modelID = ifcApi.OpenModel(buffer);
        api = ifcApi;
        const rebarIds = new Set<number>(Array.from(ifcApi.GetLineIDsWithType(modelID, ifc.IFCREINFORCINGBAR)));

        const rebarBuckets = new Map<string, { bucket: Bucket; color: THREE.Color }>();
        const rebarBucketFor = (color: { x: number; y: number; z: number }, hasColor: boolean) => {
          const key = hasColor ? `${color.x.toFixed(3)},${color.y.toFixed(3)},${color.z.toFixed(3)}` : 'default';
          let item = rebarBuckets.get(key);
          if (!item) {
            item = {
              bucket: emptyBucket(),
              color: hasColor
                ? new THREE.Color().setRGB(color.x, color.y, color.z)
                : new THREE.Color(0xb45309),
            };
            rebarBuckets.set(key, item);
          }
          return item.bucket;
        };
        const concrete = emptyBucket();
        const matrix = new THREE.Matrix4();
        const normalMatrix = new THREE.Matrix3();
        const point = new THREE.Vector3();
        const normal = new THREE.Vector3();

        const add = (bucket: Bucket, vertexData: Float32Array, indexData: Uint32Array, transform: number[], expressID: number) => {
          matrix.fromArray(transform);
          normalMatrix.getNormalMatrix(matrix);
          const count = vertexData.length / 6;
          const positions = new Float32Array(count * 3);
          const normals = new Float32Array(count * 3);
          for (let i = 0; i < count; i += 1) {
            point.set(vertexData[i * 6], vertexData[i * 6 + 1], vertexData[i * 6 + 2]).applyMatrix4(matrix);
            positions[i * 3] = point.x; positions[i * 3 + 1] = point.y; positions[i * 3 + 2] = point.z;
            normal.set(vertexData[i * 6 + 3], vertexData[i * 6 + 4], vertexData[i * 6 + 5]).applyMatrix3(normalMatrix).normalize();
            normals[i * 3] = normal.x; normals[i * 3 + 1] = normal.y; normals[i * 3 + 2] = normal.z;
          }
          const indices = new Uint32Array(indexData.length);
          for (let i = 0; i < indexData.length; i += 1) indices[i] = indexData[i] + bucket.base;
          const ids = new Float32Array(count);
          ids.fill(expressID);
          bucket.base += count;
          bucket.pos.push(positions);
          bucket.nrm.push(normals);
          bucket.pid.push(ids);
          bucket.idx.push(indices);
        };

        let processed = 0;
        let total = 1;
        ifcApi.StreamAllMeshes(modelID, (mesh, index, sum) => {
          if (disposed) return;
          total = sum || total;
          processed = index + 1;
          const isRebar = rebarIds.has(mesh.expressID);
          for (let i = 0; i < mesh.geometries.size(); i += 1) {
            const placed = mesh.geometries.get(i);
            const geometry = ifcApi.GetGeometry(modelID, placed.geometryExpressID);
            const vertexData = ifcApi.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
            const indexData = ifcApi.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
            const target = isRebar ? rebarBucketFor(placed.color, placed.hasColor) : concrete;
            add(target, vertexData, indexData, placed.flatTransformation as unknown as number[], mesh.expressID);
            geometry.delete();
          }
          if (processed % 200 === 0 || processed === total) {
            const ratio = Math.min(0.96, processed / Math.max(total, 1));
            setStatus({ loading: true, progress: 25 + ratio * 70, message: `生成几何 ${processed}/${total}`, error: '' });
          }
        });

        if (disposed) return;
        setStatus({ loading: true, progress: 97, message: '构建场景…', error: '' });

        const concreteGeometry = buildGeometry(concrete);
        const box = new THREE.Box3();
        // 剖切 / 边缘线共用的材质清单
        const clipTargets: THREE.Material[] = [];
        let concreteEdges: THREE.LineSegments | null = null;
        const applyMode = (mode: ViewMode) => {
          const mesh = concreteMeshRef.current;
          if (!mesh) return;
          const material = mesh.material as THREE.MeshStandardMaterial;
          const solid = mode === 'solid';
          material.transparent = !solid;
          material.opacity = solid ? 1 : 0.32;
          material.depthWrite = solid;
          material.needsUpdate = true;
          mesh.visible = mode !== 'rebar';
          // 轮廓线只在实体模式下出现，透视时会把钢筋遮住
          if (concreteEdges) concreteEdges.visible = solid;
        };
        applyModeRef.current = applyMode;
        if (concreteGeometry) {
          const material = new THREE.MeshStandardMaterial({
            color: 0xd3dae3, roughness: 0.92, metalness: 0.02, side: THREE.DoubleSide,
            transparent: true, opacity: 0.32, depthWrite: false,
          });
          clipTargets.push(material);
          const mesh = new THREE.Mesh(concreteGeometry, material);
          concreteMeshRef.current = mesh;
          root.add(mesh);
          // 混凝土之间没有明暗差就糊成一片，用轮廓线把每个构件分开
          concreteEdges = new THREE.LineSegments(
            new THREE.EdgesGeometry(concreteGeometry, 32),
            new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.5 }),
          );
          concreteEdges.visible = false;
          clipTargets.push(concreteEdges.material as THREE.Material);
          root.add(concreteEdges);
        }
        // 主筋/箍筋/加强箍在 IFC 里各带一种材质色，按颜色分开建 mesh 才能看出层次
        rebarBuckets.forEach(({ bucket, color }) => {
          const geometry = buildGeometry(bucket);
          if (!geometry) return;
          const material = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.25 });
          clipTargets.push(material);
          root.add(new THREE.Mesh(geometry, material));
        });
        rebarBuckets.clear();

        root.updateMatrixWorld(true);
        box.setFromObject(root);

        if (box.isEmpty()) {
          setStatus({ loading: false, progress: 100, message: '模型没有可显示的几何', error: '' });
          return;
        }
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const radius = Math.max(size.x, size.y, size.z, 1);
        // 地坪只留 y=0 的网格：基坑在平面上是斜的（45°），用矩形或凸包挖洞
        // 都会在某个视角把坑口盖住，不如不画实体地面。
        grid.scale.setScalar(Math.max(radius / 45, 0.5));
        grid.position.set(center.x, 0.01, center.z);
        scene.fog = new THREE.Fog(0xf7fafc, radius * 2.4, radius * 7);
        // 视角要够高才看得进坑里。之前 y = 0.55×半径，俯角只有 26°，
        // 基本是平视近侧墙——一堵墙挂在地面下面，当然像"歪了"。
        camera.position.set(center.x + radius * 0.68, radius * 1.0, center.z + radius * 0.84);
        // 原来的 near/far 收得太紧（radius/200 ~ radius*20），推到最近时模型被近裁剪面切掉，
        // 看起来就像"缩放到头了"。放宽一个量级，再显式给一个宽松的缩放区间。
        camera.near = radius / 2000;
        camera.far = radius * 40;
        camera.updateProjectionMatrix();
        controls.minDistance = Math.max(radius * 0.01, 0.5);
        controls.maxDistance = radius * 10;
        // 不允许转到地面以下：从底下往上看，坑会变成一堵悬空的墙
        controls.maxPolarAngle = Math.PI * 0.495;
        // 视点对准坑底与地面的中间，先看见坑口，再看坑里
        controls.target.set(center.x, box.min.y * 0.45, center.z);
        controls.update();

        applyMode(modeRef.current);

        // ---- 剖切：沿进深方向切一刀，看到桩、墙、支撑的剖面关系 ----
        const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), box.max.z);
        const applySection = (value: number | null) => {
          const planes: THREE.Plane[] = [];
          if (value !== null) {
            clipPlane.constant = box.max.z - (box.max.z - box.min.z) * (value / 100);
            planes.push(clipPlane);
          }
          clipTargets.forEach((target) => {
            target.clippingPlanes = planes;
            target.needsUpdate = true;
          });
        };
        applySectionRef.current = applySection;
        if (sectionRef.current !== null) applySection(sectionRef.current);

        // ---- 点选构件：从几何反查 expressID，再读 IfcPropertySet ----
        // 合并后的 mesh 没有构件边界，靠 aPid 属性找回"这个三角面属于哪个构件"。
        const raycaster = new THREE.Raycaster();
        const pointer = new THREE.Vector2();
        let downAt: { x: number; y: number } | null = null;

        const highlight = new THREE.Box3Helper(new THREE.Box3(), 0x1d4ed8);
        highlight.visible = false;
        const highlightMaterial = highlight.material as THREE.LineBasicMaterial;
        highlightMaterial.depthTest = false;
        highlightMaterial.transparent = true;
        highlightMaterial.opacity = 0.9;
        // 选中框要跟着剖切一起被裁掉，否则选中的构件被切走后，框还悬在空中
        clipTargets.push(highlightMaterial);
        scene.add(highlight);
        if (sectionRef.current !== null) applySectionRef.current(sectionRef.current);

        const clearPick = () => {
          highlight.visible = false;
          setPicked(null);
        };
        clearPickRef.current = clearPick;

        const plain = (value: any): any => {
          if (value === null || value === undefined) return null;
          if (typeof value === 'object') {
            if ('value' in value) return plain(value.value);
            if ('name' in value) return plain(value.name);
            return null;
          }
          return value;
        };
        const format = (value: any): string => {
          if (value === null || value === undefined) return '—';
          if (typeof value === 'number') {
            return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
          }
          if (typeof value === 'boolean') return value ? '是' : '否';
          return String(value);
        };

        // 关系表只在第一次点选时扫一遍：13892 条 IfcRelDefinesByProperties 全读要几秒，
        // 不能压进加载进度条里。
        const psetIndex = new Map<number, number[]>();
        let psetScanned = false;
        const scanPsets = () => {
          if (psetScanned) return;
          psetScanned = true;
          const relIds = ifcApi.GetLineIDsWithType(modelID, ifc.IFCRELDEFINESBYPROPERTIES);
          for (let i = 0; i < relIds.size(); i += 1) {
            const rel = ifcApi.GetLine(modelID, relIds.get(i), false);
            // IFC4 把 RelatingPropertySet 改名成 RelatingPropertyDefinition
            const psetId = Number(plain(rel?.RelatingPropertySet ?? rel?.RelatingPropertyDefinition));
            if (!Number.isFinite(psetId) || psetId <= 0) continue;
            const objects = rel?.RelatedObjects || [];
            for (let j = 0; j < objects.length; j += 1) {
              const elementId = Number(plain(objects[j]));
              if (!Number.isFinite(elementId)) continue;
              const list = psetIndex.get(elementId);
              if (list) {
                if (!list.includes(psetId)) list.push(psetId);
              } else {
                psetIndex.set(elementId, [psetId]);
              }
            }
          }
        };

        const readElement = (id: number): Picked => {
          scanPsets();
          const line = ifcApi.GetLine(modelID, id, false);
          const typeName = ifcApi.GetNameFromTypeCode(ifcApi.GetLineType(modelID, id)) || 'IfcProduct';
          const typeKey = typeName.replace(/^Ifc/, '').toUpperCase();
          const groups: PickedGroup[] = [];
          for (const psetId of psetIndex.get(id) || []) {
            const pset = ifcApi.GetLine(modelID, psetId, false);
            const rows: PickedRow[] = [];
            for (const propertyRef of pset?.HasProperties || []) {
              const propertyId = Number(plain(propertyRef));
              if (!Number.isFinite(propertyId) || propertyId <= 0) continue;
              const property = ifcApi.GetLine(modelID, propertyId, false);
              if (!property) continue;
              let value = plain(property.NominalValue);
              if (value === null && Array.isArray(property.EnumerationValues)) {
                value = property.EnumerationValues.map((item: any) => plain(item)).filter((item: any) => item !== null).join(' / ');
              }
              if (value === null && Array.isArray(property.ListValues)) {
                value = property.ListValues.map((item: any) => plain(item)).filter((item: any) => item !== null).join(' / ');
              }
              const rawName = String(plain(property.Name) ?? '—');
              const text = propertyValue(rawName, format(value));
              // 不适用的字段导出时留空（立柱的"桩径"就是这种）。全列出来一排"—"，
              // 看的人会以为数据缺了，其实这一项对它不成立。
              if (text === '—' || text === '') continue;
              rows.push({
                name: propertyLabel(rawName),
                raw: rawName,
                value: text,
              });
            }
            if (rows.length) {
              groups.push({ name: psetLabel(String(plain(pset?.Name) ?? '属性集')), rows });
            }
          }
          return {
            id,
            type: typeName,
            label: TYPE_LABELS[typeKey] || typeName,
            globalId: String(plain(line?.GlobalId) ?? ''),
            groups,
          };
        };

        const onPointerDown = (event: PointerEvent) => {
          if (event.button === 0) downAt = { x: event.clientX, y: event.clientY };
        };
        const onPointerUp = (event: PointerEvent) => {
          if (!downAt || event.button !== 0) return;
          const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y);
          downAt = null;
          if (moved > 5) return; // 拖动旋转 / 平移不当作点选

          const rect = renderer.domElement.getBoundingClientRect();
          pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
          pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
          raycaster.setFromCamera(pointer, camera);
          const meshes = root.children.filter((child) => (child as THREE.Mesh).isMesh);
          const hits = raycaster.intersectObjects(meshes, false);
          // 透视下混凝土几乎全透明，若仍参与拾取就永远先撞到最外层墙，钢筋点不到
          const candidates = modeRef.current === 'solid'
            ? hits
            : hits.filter((hit) => hit.object !== concreteMeshRef.current);
          const hit = candidates[0];
          if (!hit || !hit.face) {
            clearPick();
            return;
          }
          const geometry = (hit.object as THREE.Mesh).geometry as THREE.BufferGeometry;
          const pid = geometry.getAttribute('aPid');
          const position = geometry.getAttribute('position');
          if (!pid || !position) return;
          const expressID = pid.getX(hit.face.a);

          const box = new THREE.Box3();
          const point = new THREE.Vector3();
          for (let i = 0; i < pid.count; i += 1) {
            if (pid.getX(i) !== expressID) continue;
            point.set(position.getX(i), position.getY(i), position.getZ(i));
            box.expandByPoint(point);
          }
          if (!box.isEmpty()) {
            box.applyMatrix4((hit.object as THREE.Mesh).matrixWorld);
            highlight.box.copy(box);
            highlight.updateMatrixWorld(true);
            highlight.visible = true;
          }
          setPicked(readElement(expressID));
        };

        renderer.domElement.addEventListener('pointerdown', onPointerDown);
        renderer.domElement.addEventListener('pointerup', onPointerUp);
        cleanupPickRef.current = () => {
          renderer.domElement.removeEventListener('pointerdown', onPointerDown);
          renderer.domElement.removeEventListener('pointerup', onPointerUp);
          scene.remove(highlight);
          highlightMaterial.dispose();
          clearPickRef.current = () => {};
        };

        if (autoPick?.type) {
          try {
            const typeCode = (ifc as unknown as Record<string, number>)[autoPick.type];
            const ids = ifcApi.GetLineIDsWithType(modelID, typeCode);
            const index = Math.min(autoPick.index ?? 0, ids.size() - 1);
            if (index >= 0) {
              const target = ids.get(index);
              const targetBox = new THREE.Box3();
              const vertex = new THREE.Vector3();
              for (const child of root.children) {
                const mesh = child as THREE.Mesh;
                const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
                const pid = geometry?.getAttribute?.('aPid');
                const position = geometry?.getAttribute?.('position');
                if (!pid || !position) continue;
                let matched = false;
                for (let i = 0; i < pid.count; i += 1) {
                  if (pid.getX(i) !== target) continue;
                  vertex.set(position.getX(i), position.getY(i), position.getZ(i));
                  targetBox.expandByPoint(vertex);
                  matched = true;
                }
                if (matched) {
                  targetBox.applyMatrix4(mesh.matrixWorld);
                  highlight.box.copy(targetBox);
                  highlight.updateMatrixWorld(true);
                  highlight.visible = true;
                  break;
                }
              }
              setPicked(readElement(target));
            }
          } catch {
            // 截图辅助功能，失败不影响正常浏览
          }
        }

        setStatus({ loading: false, progress: 100, message: `已加载 · 钢筋 ${rebarIds.size.toLocaleString()} 根`, error: '' });
      } catch (err) {
        if (!disposed) {
          setStatus({ loading: false, progress: 0, message: '', error: err instanceof Error ? err.message : String(err) });
        }
      }
    };

    void run();

    return () => {
      disposed = true;
      concreteMeshRef.current = null;
      applyModeRef.current = () => {};
      applySectionRef.current = () => {};
      cleanupPickRef.current();
      clearPickRef.current = () => {};
      setPicked(null);
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      if (api && modelID >= 0) {
        try { api.CloseModel(modelID); } catch { /* 关闭失败不阻塞卸载 */ }
      }
      canvas.removeEventListener('pointerdown', blockNativeButtons);
      canvas.removeEventListener('mousedown', blockNativeButtons);
      canvas.removeEventListener('contextmenu', blockContextMenu);
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(material)) material.forEach((item) => item.dispose());
        else material?.dispose();
      });
      renderer.dispose();
      if (renderer.domElement.parentElement === host) host.removeChild(renderer.domElement);
    };
  }, [url, height]);

  return (
    <div className="bimViewer" style={{ height }}>
      <div className="bimViewerHost" ref={hostRef} />
      {status.loading ? (
        <div className="bimViewerOverlay">
          <div className="bimViewerBar"><span style={{ width: `${Math.max(4, Math.min(100, status.progress))}%` }} /></div>
          <p>{status.message}</p>
          <small>首次解析大模型需要 20–60 秒，之后浏览器会缓存</small>
        </div>
      ) : null}
      {status.error ? (
        <div className="bimViewerOverlay error">
          <p>{status.error}</p>
          <small>可先下载 IFC 到本地，用 BIM Vision 或 BlenderBIM 打开</small>
        </div>
      ) : null}
      {!status.loading && !status.error ? <div className="bimViewerBadge">{status.message}</div> : null}
      {!status.loading && !status.error ? (
        <div className={`bimViewerLegend${picked ? ' shifted' : ''}`}>
          {REBAR_LEGEND.map((item) => (
            <span key={item.label}><i style={{ background: item.color }} />{item.label}</span>
          ))}
          <em>左键旋转 · 中键平移 · 滚轮缩放 · 单击看属性</em>
        </div>
      ) : null}
      {!status.loading && !status.error ? (
        <div className="bimViewerModes" role="group" aria-label="显示模式">
          {VIEW_MODES.map((mode) => (
            <button
              key={mode.key}
              type="button"
              title={mode.hint}
              className={viewMode === mode.key ? 'active' : ''}
              onClick={() => {
                modeRef.current = mode.key;
                setViewMode(mode.key);
                applyModeRef.current(mode.key);
              }}
            >
              {mode.label}
            </button>
          ))}
        </div>
      ) : null}
      {!status.loading && !status.error ? (
        <div className="bimViewerSection">
          <label>
            <input
              type="checkbox"
              checked={section !== null}
              onChange={(event) => {
                const value = event.target.checked ? 55 : null;
                sectionRef.current = value;
                setSection(value);
                applySectionRef.current(value);
              }}
            />
            剖切
          </label>
          {section !== null ? (
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={section}
              aria-label="剖切位置"
              onChange={(event) => {
                const value = Number(event.target.value);
                sectionRef.current = value;
                setSection(value);
                applySectionRef.current(value);
              }}
            />
          ) : null}
        </div>
      ) : null}
      {picked ? (
        <aside className="bimViewerProps" aria-label="构件属性">
          <header>
            <div>
              <strong>{picked.label}</strong>
              <span>{picked.type} · #{picked.id}</span>
            </div>
            <button
              type="button"
              title="关闭"
              onClick={() => clearPickRef.current()}
            >
              ×
            </button>
          </header>
          <div className="bimViewerPropsBody">
            {picked.globalId ? (
              <p className="bimViewerPropsId">GUID {picked.globalId}</p>
            ) : null}
            {picked.groups.length ? picked.groups.map((group) => (
              <section key={group.name}>
                <h4>{group.name}</h4>
                <dl>
                  {group.rows.map((row, index) => (
                    <div key={`${group.name}-${row.name}-${index}`}>
                      <dt title={row.raw}>{row.name}</dt>
                      <dd title={row.value}>{row.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )) : (
              <p className="bimViewerPropsEmpty">这个构件没有附带属性集，只有几何。</p>
            )}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
