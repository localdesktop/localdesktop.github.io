# Start from the alpine-android image with Android SDK 30 and JDK 17
FROM alvrme/alpine-android:android-30-jdk17

ENV GRADLE_OPTS="-XX:+UseG1GC -XX:MaxGCPauseMillis=1000"

# Install Gradle 8
RUN wget https://services.gradle.org/distributions/gradle-8.14.2-bin.zip -P /tmp \
    && echo "7197a12f450794931532469d4ff21a59ea2c1cd59a3ec3f89c035c3c420a6999  /tmp/gradle-8.14.2-bin.zip" | sha256sum -c -
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
RUN source $HOME/.cargo/env && cargo install --locked --path /app/patches/xbuild/xbuild

# Copy the Rust project files into the container
COPY . /app
WORKDIR /app

# Compile APK (fails if Cargo.lock is out of date)
RUN source $HOME/.cargo/env && cargo metadata --locked --format-version=1 > /dev/null && x build --release --platform android --arch arm64 --format apk

