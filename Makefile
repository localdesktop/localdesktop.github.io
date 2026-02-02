install-xbuild:
	cargo install --path ./patches/xbuild/xbuild

build: install-xbuild
	x build --release --platform android --arch arm64 --format apk

build-docker:
	docker build -t localdesktop-build-image .
	docker create --name localdesktop-build-container localdesktop-build-image
	docker cp localdesktop-build-container:/app/target ./target
	docker rm localdesktop-build-container
	docker rmi localdesktop-build-image
