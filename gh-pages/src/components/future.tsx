export default function Future() {
  return (
    <section
      className="py-20 px-4 relative overflow-hidden bg-no-repeat bg-right"
      style={{ backgroundImage: "url('/img/future-bg.webp')" }}
    >
      <div className="absolute inset-0 bg-gradient-to-r from-white from-30% to-transparent to-100% dark:from-gray-900 dark:from-30% dark:to-transparent dark:to-100% z-0"></div>
      <div className="max-w-5xl mx-auto relative z-10 grid grid-cols-1 md:grid-cols-2 gap-12 items-center">
        <div>
          <div className="space-y-8 text-gray-700 dark:text-gray-300 font-serif border-l-4 border-gray-300 dark:border-gray-600 pl-6">
            <p className="text-lg leading-relaxed">
              "Android devices are becoming more powerful and capable of running
              desktop-grade applications. Android tablet manufacturers are
              making their screens bigger and packaging them with keyboards.
              Google is developing an in-house desktop mode in Android 16,
              adopting the trend that allows your phone to be plugged into a
              monitor and become a mini PC. These are signs of a positive future
              where you can perform work such as image editing, video
              production, running local web servers, inspecting the web,
              debugging the code, and doing software development - what you
              usually do on Linux - on Android.
            </p>
            <p className="text-lg leading-relaxed">
              Software support is the missing piece, and Local Desktop provides
              just that. I believe this is the beginning of something super
              useful in the future. There is so much potential, so much more to
              develop."
            </p>
            <p className="text-lg italic text-right">- Mister Teddy</p>
          </div>
        </div>
        <div className="hidden md:block"></div>
      </div>
    </section>
  );
}
