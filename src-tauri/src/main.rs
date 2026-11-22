// 桌面壳入口（Windows 桌面程序，不弹控制台窗口）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    desktop_pet_lib::run();
}
