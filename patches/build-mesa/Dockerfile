# A private Mesa for the Arch Linux ARM guest: Turnip on Qualcomm's KGSL (the only GPU device
# Android lets apps open) and Zink for OpenGL on top of it. It installs under
# /opt/localdesktop-mesa so it never collides with the distro's mesa package, which is built
# without KGSL support. Build for linux/arm64 (see build.sh).
FROM menci/archlinuxarm:base-devel

ARG MESA_VERSION=26.2.5

# pacman can't apply its Landlock sandbox inside a container.
RUN sed -i '/^\[options\]/a DisableSandbox' /etc/pacman.conf && \
    pacman -Syu --noconfirm --needed \
    meson ninja python-mako python-yaml python-packaging python-ply bison flex glslang \
    wayland wayland-protocols libdrm libglvnd vulkan-headers vulkan-icd-loader \
    libx11 libxext libxfixes libxdamage libxrandr libxxf86vm libxshmfence libxcb xorgproto \
    expat zstd zlib libelf

WORKDIR /mesa
RUN curl -fsSL https://archive.mesa3d.org/mesa-${MESA_VERSION}.tar.xz | tar xJ --strip-components=1
COPY *.patch /patches/
# A distinct version keeps libgallium's soname apart from the distro's, should both end up in
# one process. softpipe is only there so a Zink failure degrades to slow software rendering
# rather than no OpenGL at all; llvmpipe would tie the build to the guest's LLVM version.
RUN for patch in /patches/*.patch; do patch -p1 < "$patch"; done && \
    echo "${MESA_VERSION}-localdesktop" > VERSION

RUN meson setup out \
    -Dprefix=/opt/localdesktop-mesa -Dlibdir=lib -Dbuildtype=release -Db_ndebug=true \
    -Dc_link_args=-Wl,-rpath,/opt/localdesktop-mesa/lib \
    -Dcpp_link_args=-Wl,-rpath,/opt/localdesktop-mesa/lib \
    -Dplatforms=x11,wayland -Dgallium-drivers=zink,softpipe -Dvulkan-drivers=freedreno \
    -Dfreedreno-kmds=kgsl -Dopengl=true -Degl=enabled -Dglx=dri -Dgles1=disabled -Dgles2=enabled \
    -Dgbm=disabled -Dglvnd=enabled -Dglvnd-vendor-name=localdesktop -Dllvm=disabled \
    -Dlmsensors=disabled -Dvalgrind=disabled -Dlibunwind=disabled -Dspirv-tools=disabled \
    -Dvulkan-layers= -Dvideo-codecs= -Dgallium-va=disabled -Dgallium-rusticl=false \
    -Dteflon=false -Dmicrosoft-clc=disabled -Dzstd=enabled -Dexpat=enabled && \
    ninja -C out && DESTDIR=/stage ninja -C out install

COPY vkprobe.c env.sh /extra/
RUN cd /stage/opt/localdesktop-mesa && \
    rm -rf include lib/pkgconfig && \
    mkdir -p bin && gcc -O2 -Wall -o bin/vkprobe /extra/vkprobe.c -ldl && \
    cp /extra/env.sh env.sh && \
    sed -i 's|"libEGL_localdesktop.so.0"|"/opt/localdesktop-mesa/lib/libEGL_localdesktop.so.0"|' \
    share/glvnd/egl_vendor.d/50_localdesktop.json && \
    find . -type f \( -name '*.so*' -o -path ./bin/vkprobe \) -exec strip --strip-unneeded {} + && \
    echo "mesa ${MESA_VERSION}-localdesktop" > VERSION && \
    tar -C /stage -cJf /guest-mesa.tar.xz opt
