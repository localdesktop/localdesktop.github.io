# Use the official Arch Linux image
FROM archlinux/archlinux:base

# Update and install necessary dependencies
RUN pacman -Syu --noconfirm \
    base-devel \
    meson \
    ninja \
    clang \
    llvm \
    pkgconf \
    python \
    python-pip \
    git \
    meson \
    ninja \
    unzip \
    autoconf

# Download and extract Android NDK
RUN curl -o android-ndk-r28-linux.zip https://dl.google.com/android/repository/android-ndk-r28-linux.zip && \
    unzip android-ndk-r28-linux.zip && \
    rm android-ndk-r28-linux.zip

# Set environment variables
ENV ANDROID_NDK_HOME=/android-ndk-r28
ENV PATH=$PATH:/android-ndk-r28

# Set working directory for the container
WORKDIR /

COPY ndk-crossfile.txt /ndk-crossfile.txt

# Create output directory for built files
RUN mkdir /output

# Clone libraries
RUN git clone https://github.com/xkbcommon/libxkbcommon.git

# Build libxkbcommon with 16 KB page size
RUN cd /libxkbcommon && \
    meson setup build/ \
    --cross-file /ndk-crossfile.txt \
    -Denable-tools=false \
    -Denable-x11=false \
    -Denable-xkbregistry=false \
    -Denable-bash-completion=false \
    -Dxkb-config-root=/data/data/app.polarbear.fold/files/arch/usr/share/X11/xkb \
    -Dx-locale-root=/data/data/app.polarbear.fold/files/arch/usr/share/X11/locale \
    -Dprefix=/output && \
    meson compile -C build/ && \
    meson install -C build/