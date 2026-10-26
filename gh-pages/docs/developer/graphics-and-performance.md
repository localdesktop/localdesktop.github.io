# Graphics and performance diagnostics

Local Desktop has two distinct graphics layers. Keeping them separate is essential when diagnosing performance or discussing GPU acceleration.

## Host compositor acceleration

The Android application creates an EGL context and uses Smithay's OpenGL ES renderer to composite the desktop into an Android native window. The implementation prefers hardware-accelerated OpenGL ES 3 contexts and falls back to less restrictive configurations when a device or emulator cannot provide the preferred format.

This accelerates the Local Desktop compositor itself. It does **not** automatically provide direct GPU acceleration to Linux applications running inside PRoot.

The compositor already logs the selected OpenGL ES version, vendor, renderer, extensions, and fallback path. Those log lines are useful when determining whether the Android-facing renderer is operating on hardware or software.

## Guest application acceleration

Linux applications run inside a PRoot filesystem while sharing Android's kernel. PRoot is not a virtual machine and does not reserve a separate block of guest RAM. Guest processes use host memory subject to Android's normal process and memory-management policies.

Guest GPU acceleration requires more than installing Mesa packages. A working implementation needs all of the following:

1. A device node and kernel driver that the Android application can access.
2. A userspace driver compatible with that kernel interface.
3. A compatible EGL or Vulkan loader.
4. Correct library, ICD, and environment configuration inside PRoot.
5. Safe fallback behavior for unsupported devices.

Installing `mesa`, `vulkan-tools`, or an ICD file without the matching Android driver bridge can produce misleading package-level success while applications continue to render on the CPU.

## Turnip and Adreno

Turnip is Mesa's Vulkan driver for Qualcomm Adreno GPUs. It is not a generic Android GPU driver and does not apply to Mali, PowerVR, or other GPU families.

Supporting Turnip inside Local Desktop should therefore be treated as an experimental, device-aware feature rather than a default package installation. At minimum, an implementation must validate:

- Qualcomm/Adreno hardware detection;
- access to `/dev/kgsl-3d0`;
- Android Vulkan loader and vendor-library compatibility;
- Mesa/Turnip build compatibility with the target Android release;
- operation inside PRoot without weakening application isolation unexpectedly;
- clean fallback to software rendering when any prerequisite is absent.

Xwayland is not the fundamental blocker. Native Wayland clients and Xwayland clients both require a functional accelerated guest rendering stack before they can avoid software rendering.

## Mali devices

Turnip cannot accelerate Mali GPUs. Mali support depends on the device's kernel interface and a compatible userspace driver, which varies considerably by vendor, Android version, and device firmware. Reports from Mali devices must therefore include the exact device model, Android build, available device nodes, and renderer output rather than assuming that the Qualcomm path applies.

## Collecting a support report

Run the repository utility from inside the Local Desktop Linux environment:

```bash
sh scripts/localdesktop-support-report.sh > localdesktop-support-report.txt
```

The script is read-only. It collects:

- session and display environment variables;
- relevant Android GPU device nodes;
- installed graphics packages;
- OpenGL, EGL, Vulkan, Wayland, and PulseAudio diagnostics when their tools are installed;
- storage mounts;
- a small CPU and memory snapshot.

Review the report for sensitive information before attaching it to a GitHub issue.

## Interpreting common results

| Result | Meaning |
| --- | --- |
| Host log names an Adreno or Mali renderer | The Android-facing compositor is likely using the device GPU. |
| `glxinfo -B` reports `llvmpipe` | X11 applications inside the guest are software-rendered. |
| `vulkaninfo` cannot find a physical device | The guest has no functioning Vulkan driver path. |
| `/dev/kgsl-3d0` is unavailable | A Turnip/Adreno guest path cannot work in its current form. |
| Audio server is configured but `pactl` cannot connect | Diagnose the host PulseAudio process and TCP endpoint before changing Firefox. |
| `/android` and `/root/Android` are absent | Android all-files access was not granted or storage binding was not enabled. |

## Filing actionable performance issues

A useful performance report should contain:

- Local Desktop version;
- device manufacturer and exact model;
- Android version and build identifier;
- SoC and GPU family;
- whether the device is rooted or uses custom firmware;
- the complete support report;
- one reproducible workload;
- observed and expected behavior;
- whether the problem affects native Wayland applications, Xwayland applications, or both;
- relevant Android logs when available.

Do not combine unrelated installation, touch-input, browser, audio, package-management, and GPU requests into one optimization issue. Separate reports make regression testing and review substantially more reliable.
