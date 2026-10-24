/* Exit 0 when the Vulkan loader exposes a Turnip device, so the session only
 * routes GL through Zink on GPUs Turnip supports. Loads libvulkan at runtime to
 * avoid a link-time dependency. */
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
#include <vulkan/vulkan.h>

int main(void)
{
   void *lib = dlopen("libvulkan.so.1", RTLD_NOW | RTLD_LOCAL);
   if (!lib)
      return 1;

   PFN_vkGetInstanceProcAddr gipa =
      (PFN_vkGetInstanceProcAddr)dlsym(lib, "vkGetInstanceProcAddr");
   if (!gipa)
      return 1;

   PFN_vkCreateInstance create_instance =
      (PFN_vkCreateInstance)gipa(NULL, "vkCreateInstance");
   VkApplicationInfo app = {
      .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
      .pApplicationName = "localdesktop-vkprobe",
      .apiVersion = VK_API_VERSION_1_1,
   };
   VkInstanceCreateInfo info = {
      .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
      .pApplicationInfo = &app,
   };
   VkInstance instance;
   if (!create_instance || create_instance(&info, NULL, &instance) != VK_SUCCESS)
      return 1;

   PFN_vkEnumeratePhysicalDevices enumerate =
      (PFN_vkEnumeratePhysicalDevices)gipa(instance, "vkEnumeratePhysicalDevices");
   PFN_vkGetPhysicalDeviceProperties properties =
      (PFN_vkGetPhysicalDeviceProperties)gipa(instance, "vkGetPhysicalDeviceProperties");
   VkPhysicalDevice devices[8];
   uint32_t count = 8;
   int found = 0;
   if (enumerate && properties && enumerate(instance, &count, devices) >= 0) {
      for (uint32_t i = 0; i < count; i++) {
         VkPhysicalDeviceProperties props;
         properties(devices[i], &props);
         if (strncmp(props.deviceName, "Turnip", 6) == 0) {
            puts(props.deviceName);
            found = 1;
         }
      }
   }

   PFN_vkDestroyInstance destroy =
      (PFN_vkDestroyInstance)gipa(instance, "vkDestroyInstance");
   if (destroy)
      destroy(instance, NULL);
   return found ? 0 : 1;
}
