# Sourced by the desktop session. Routes Vulkan to Turnip on KGSL and OpenGL to Zink on top
# of it, but only when Turnip finds a GPU it supports; otherwise the distro's Mesa (llvmpipe)
# stays in charge. Set LOCALDESKTOP_GPU=0 to opt out.
mesa=/opt/localdesktop-mesa
icd=$mesa/share/vulkan/icd.d/freedreno_icd.aarch64.json
if [ "${LOCALDESKTOP_GPU:-1}" != 0 ] && VK_DRIVER_FILES=$icd "$mesa/bin/vkprobe" >/dev/null 2>&1; then
    export VK_ADD_DRIVER_FILES=$icd
    # labwc renders with pixman and offers no dma-buf, so present through wl_shm/MIT-SHM.
    export MESA_VK_WSI_DEBUG=sw
    export __EGL_VENDOR_LIBRARY_FILENAMES=$mesa/share/glvnd/egl_vendor.d/50_localdesktop.json
    export __GLX_VENDOR_LIBRARY_NAME=localdesktop
    export MESA_LOADER_DRIVER_OVERRIDE=zink
    # Zink without a DRM render node: present through kopper (Vulkan WSI) on X11 and Wayland.
    export LIBGL_KOPPER_DRI2=1
fi
unset mesa icd
