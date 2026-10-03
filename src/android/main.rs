use crate::{
    android::{
        accessibility::{register_event_loop_proxy, AppUserEvent},
        app::build::PolarBearApp,
        crash_report,
        utils::{
            application_context::{get_application_context, ApplicationContext},
            host_bridge,
        },
    },
    core::config::ARCH_FS_ROOT,
};
use winit::{
    event_loop::{ControlFlow, EventLoop},
    platform::android::{activity::AndroidApp, EventLoopBuilderExtAndroid},
};

#[no_mangle]
fn android_main(android_app: AndroidApp) {
    std::env::set_var("RUST_BACKTRACE", "full");
    // The bundled libxkbcommon.so has the upstream rootfs path (/data/data/app.polarbear/...)
    // compiled in as its keymap root, which does not exist under this fork's application id.
    // Without these the compositor cannot compile a keymap and fails to start.
    std::env::set_var(
        "XKB_CONFIG_ROOT",
        format!("{ARCH_FS_ROOT}/usr/share/X11/xkb"),
    );
    std::env::set_var("XLOCALEDIR", format!("{ARCH_FS_ROOT}/usr/share/X11/locale"));
    // Local-only logging and crash reports; nothing is sent off the device.
    crash_report::init(&android_app);

    ApplicationContext::build(&android_app);

    host_bridge::apply_immersive(&android_app);
    host_bridge::set_keep_screen_on(
        &android_app,
        get_application_context().local_config.display.keep_screen_on,
    );

    let event_loop = EventLoop::<AppUserEvent>::with_user_event()
        .with_android_app(android_app.clone())
        .build()
        .expect("Failed to create event loop");
    register_event_loop_proxy(event_loop.create_proxy());

    // ControlFlow::Poll continuously runs the event loop, even if the OS hasn't
    // dispatched any events. This is ideal for games and similar applications.
    // event_loop.set_control_flow(ControlFlow::Poll);

    // ControlFlow::Wait pauses the event loop if no events are available to process.
    // This is ideal for non-game applications that only update in response to user
    // input, and uses significantly less power/CPU time than ControlFlow::Poll.
    event_loop.set_control_flow(ControlFlow::Wait);

    // Phase 1: Setup
    let mut app = PolarBearApp::build(android_app);

    // Phase 2: Run
    event_loop.run_app(&mut app).expect("Failed to run app");
}
