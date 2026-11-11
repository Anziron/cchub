/**
 * 拖进输入框的文件路径。会话跑在服务器上，设备上的项目挂载在 `/mnt/<设备>/...`
 * （Windows：`D:\a\b` → `/mnt/<设备>/d/a/b`；其他系统：`/x/y` → `/mnt/<设备>/x/y`）。
 * 项目目录里的文件换成相对项目的路径；项目外的服务器读不到，保留原路径并标出来。
 */
export interface DropRef {
  path: string;
  reachable: boolean;
  /** 正在挂载所在目录，挂上后换成服务器路径。 */
  pending?: boolean;
  /** 挂载失败的原因。 */
  error?: string;
}

/**
 * 项目外的文件：假定和项目在同一台设备上（设备名取自项目目录），挂载它所在的目录后服务器就能读。
 * 盘符或根目录下的文件不挂整个盘；项目不在 `/mnt/<设备>/` 下时不知道是哪台设备，返回 null。
 */
export function mountTarget(path: string, cwd: string | undefined): { device: string; dir: string; name: string } | null {
  const device = cwd ? /^\/mnt\/([^/]+)\//.exec(`${cwd.replace(/\/+$/, "")}/`)?.[1] : undefined;
  if (!device) return null;
  const win = WINDOWS.test(path);
  if (!win && !path.startsWith("/")) return null;
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  const dir = path.slice(0, cut);
  const name = path.slice(cut + 1);
  // `D:` 或空串：文件在盘符或根目录下。
  if (!name || (win ? dir.length <= 2 : !dir)) return null;
  return { device, dir, name };
}

const WINDOWS = /^([A-Za-z]):[\\/]?(.*)$/;

/** 设备上的路径对应到服务器上的挂载路径；设备名取自当前项目目录。 */
function toServer(path: string, device: string): { server: string; caseless: boolean } | null {
  const win = WINDOWS.exec(path);
  if (win) {
    const rest = win[2].replace(/\\/g, "/").replace(/\/+$/, "");
    return { server: `/mnt/${device}/${win[1].toLowerCase()}${rest ? `/${rest}` : ""}`, caseless: true };
  }
  if (path.startsWith("/")) return { server: `/mnt/${device}${path.replace(/\/+$/, "")}`, caseless: false };
  return null;
}

function relative(server: string, root: string, caseless: boolean): string | null {
  const a = caseless ? server.toLowerCase() : server;
  const b = caseless ? root.toLowerCase() : root;
  if (a === b) return ".";
  return a.startsWith(`${b}/`) ? server.slice(root.length + 1) : null;
}

export function dropRef(path: string, cwd: string | undefined): DropRef {
  const root = cwd?.replace(/\/+$/, "");
  if (root) {
    const device = /^\/mnt\/([^/]+)\//.exec(`${root}/`)?.[1];
    const mapped = device ? toServer(path, device) : path.startsWith("/") ? { server: path, caseless: false } : null;
    const rel = mapped && relative(mapped.server, root, mapped.caseless);
    if (rel) return { path: rel, reachable: true };
  }
  return { path, reachable: false };
}

/** 发送时把文件引用写成 `@路径` 放在正文前面；路径有空格时加引号。 */
export function mentionText(paths: string[], text: string): string {
  if (!paths.length) return text;
  const refs = paths.map((p) => (/\s/.test(p) ? `@"${p}"` : `@${p}`)).join(" ");
  return text.trim() ? `${refs}\n\n${text}` : refs;
}
