# dsh-perf-hud

A transparent, draggable performance HUD for the DeepSeek Harness web UI:
**CPU / GPU / memory usage**, plus the **CPU package temperature** when the
optional helper is installed.

![dsh-perf-hud floating over the Harness window](docs/preview.png)

## Highlights

- **Fully transparent** 鈥?no card background, no border. Just three rows of text
  floating over the interface, with a soft halo so it stays readable on any
  content.
- **Drag it anywhere.** On release it anchors to the nearest window corner, so
  maximising, restoring or resizing the window keeps it exactly where you put
  it. Double-click resets to the top-right, arrow keys nudge it, and the chevron
  that appears on hover collapses it to a single row.
- **Load-aware colours** 鈥?usage turns amber at 70% and red at 90%; temperature
  at 78 掳C / 88 掳C. Stale readings dim the whole card instead of flashing a fake
  zero.
- **Theme-aware** 鈥?only `--dsw-alias-*` tokens, so it follows light, dark and
  any custom theme.
- **Local only** 鈥?the metrics route answers loopback, same-origin requests and
  returns 403 for everything else. Nothing is uploaded.

## Requirements

- **Windows 10/11.** The GPU counters, the PowerShell worker and the temperature
  helper are Windows-specific.
- DeepSeek Harness with the web UI.

## Install

From the Plugins page (install from GitHub or a local folder), or:

```sh
dsh plugin add ChendarCe/dsh-perf-hud
```

Then reload the interface once.

## What it reads

| Metric | Source |
| --- | --- |
| CPU usage | `node:os` CPU-time deltas, once a second |
| Memory usage | `os.totalmem()` / `os.freemem()` 鈥?same definition as Task Manager's "In use" |
| GPU usage | Windows `GPU Engine` performance counters, busiest engine (what Task Manager reports) |
| CPU temperature | optional helper 鈥?LibreHardwareMonitor's `CPU Package` sensor |
| GPU temperature | only when the GPU exposes a temperature sensor; most integrated GPUs do not, so the cell shows `鈥擿 |

## Temperatures (optional)

The plugin works out of the box; without the helper both temperature cells show
`鈥擿. For the real CPU package temperature, run **once** (it asks for
administrator rights):

```
helper\setup.cmd
```

That script downloads and sets up:

- **LibreHardwareMonitor 0.9.6** (portable, library only) 鈥?reads the sensors;
- **PawnIO 2.2.0**, a signed kernel driver 鈥?required to read MSRs while Windows
  "Memory integrity" (HVCI) stays enabled, so you do **not** have to weaken that
  setting;
- **`sensor-helper.ps1`**, which writes one small JSON file about every 0.4 s;
- a scheduled task **`DSH Perf Sensor`** (at logon, highest privileges, no
  window), so it never asks again.

Files go to `D:\DSHTools` when that drive exists, otherwise
`%LOCALAPPDATA%\DSHTools`. The plugin reads either location.

Measured overhead on an 8-core laptop: **0.08 % of one core and ~87 MB of RAM**
for the helper 鈥?it is mostly waiting on the driver, not burning CPU.

Remove it again with:

```
helper\uninstall.ps1              # stops the task, uninstalls the driver
helper\uninstall.ps1 -RemoveFiles # ...and deletes the helper files
```

## Limitations

- Windows only.
- GPU temperatures need a dedicated sensor; Intel integrated GPUs do not expose
  one, and the CPU package temperature is the closest reference (same die).
- The card floats **inside the Harness window**, not as a separate
  always-on-top desktop window.

## 涓枃璇存槑

DeepSeek Harness 鐣岄潰閲岀殑涓€鍧楀畬鍏ㄩ€忔槑鐨勬€ц兘璇绘暟锛欳PU / GPU / 鍐呭瓨鍗犵敤鐜囷紝鍔犱笂
CPU 灏佽娓╁害銆傛病鏈夊簳鑹插拰杈规锛屽彧鏈変笁琛屾枃瀛楁诞鍦ㄧ晫闈笂銆?
- **鎷栧姩**鍗＄墖浠绘剰浣嶇疆绉诲姩锛屾澗鎵嬪悗鍚搁檮鍒版渶杩戠殑绐楀彛瑙掞紝绐楀彛鏈€澶у寲 / 杩樺師 / 鏀瑰彉
  澶у皬閮戒繚鎸佷綅缃紱**鍙屽嚮**鍥炲埌鍙充笂瑙掞紝鏂瑰悜閿井璋冿紝鎮仠鍙充晶绠ご鍙敹璧锋垚涓€琛屻€?- 鍗犵敤鐜?鈮?0% 鍙樼惀鐝€銆佲墺90% 鍙樼孩锛涙俯搴?鈮?8 掳C / 鈮?8 掳C 鍚岀悊锛涜鏁拌繃鏈熸暣鍗″彉鏆椼€?- 瀹夎锛氭彃浠堕〉闈㈠畨瑁呮湰浠撳簱锛屾垨 `dsh plugin add ChendarCe/dsh-perf-hud`銆?- 娓╁害闇€瑕佸彲閫夊姪鎵嬶細绠＄悊鍛樿繍琛屼竴娆?`helper\setup.cmd`锛堜細瀹夎 LibreHardwareMonitor
  涓?PawnIO 绛惧悕椹卞姩锛屽苟娉ㄥ唽寮€鏈鸿嚜鍚换鍔★級銆備笉闇€瑕佹椂鐢?`helper\uninstall.ps1` 绉婚櫎銆?- 娌℃湁娓╁害鍔╂墜鏃舵俯搴︿竴鏍忔樉绀?`鈥擿锛汭ntel 鏍告樉鏈韩娌℃湁鐙珛娓╁害浼犳劅鍣紝鍚屾牱鏄剧ず `鈥擿銆?- 浠呮敮鎸?Windows锛涙偓娴獥鍦?Harness 绐楀彛鍐呴儴锛屼笉鏄嫭绔嬬殑妗岄潰缃《绐楀彛銆?
## License

[MIT](LICENSE)
