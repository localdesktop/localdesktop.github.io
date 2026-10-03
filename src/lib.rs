pub mod core {
    pub mod config;
    pub mod guest;
}

#[cfg(target_os = "android")]
pub mod android {
    pub mod accessibility;
    pub mod crash_report;

    pub mod main;
    pub mod app {
        pub mod build;
        pub mod run;
    }
    pub mod backend {
        pub mod pipewire_standalone_aaudio;
        pub mod wayland;
        pub mod webview;
    }
    pub mod proot {
        pub mod download;
        pub mod launch;
        pub mod optional;
        pub mod process;
        pub mod setup;
    }
    pub mod utils {
        pub mod application_context;
        pub mod fullscreen_immersive;
        pub mod host_bridge;
        pub mod ndk;
        pub mod webview;
    }
}
