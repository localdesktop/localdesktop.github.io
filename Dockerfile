# Start from the alpine-android image with Android SDK 30 and JDK 17
FROM alvrme/alpine-android:android-30-jdk17

ENV GRADLE_OPTS="-XX:+UseG1GC -XX:MaxGCPauseMillis=1000"

# Install Gradle 8
RUN wget https://services.gradle.org/distributions/gradle-8.14.2-bin.zip -P /tmp
RUN unzip /tmp/gradle-8.14.2-bin.zip -d /opt
RUN ln -s /opt/gradle-8.14.2/bin/gradle /usr/local/bin/gradle

# Install Rust toolchain and cargo
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
RUN source $HOME/.cargo/env && rustup target add aarch64-linux-android

# Install musl-dev libraries
RUN apk add musl-dev libgcc build-base clang llvm lld

# If running on an ARM based host, install glib compatibility layer
# This installs multi-arch libraries needed to compile in musl
RUN case "$ARCH" in \
    aarch64|armeb|armel|armhf|armv7) \
        apk add gcompat \
        ;; \
    esac

RUN mkdir /app

# Install patched xbuild
COPY ./patches/ /app/patches
RUN source $HOME/.cargo/env && cargo install --path /app/patches/xbuild/xbuild

# Copy the Rust project files into the container
COPY . /app
WORKDIR /app

# Compile APK
RUN source $HOME/.cargo/env && x build --release --platform android --arch arm64 --format apk

