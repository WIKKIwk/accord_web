import {
  Activity, Archive, Boxes, Building2, Calculator, ClipboardCheck, ClipboardList, Clock3,
  Factory, FolderTree, Home, Layers3, ListOrdered,
  MapPin, Package, PackageCheck, ScrollText, Settings2, ShieldCheck,
  SlidersHorizontal, SquareStack, Users, Warehouse, Waypoints, Wrench,
  type LucideIcon,
} from 'lucide-react'
import type { ResourceKind } from './api-types'

export interface NavigationPage {
  id: string
  title: string
  description: string
  icon: LucideIcon
  resource?: ResourceKind
}

export interface NavigationGroup {
  title: string
  pages: NavigationPage[]
}

export interface NavigationModule {
  id: 'production' | 'warehouse' | 'catalog' | 'management'
  title: string
  description: string
  icon: LucideIcon
  groups: NavigationGroup[]
}

export const homePage: NavigationPage = {
  id: 'home', title: 'Bosh sahifa', icon: Home,
  description: 'Ishlab chiqarish va omborning umumiy ko‘rinishi.',
}

export const modules: NavigationModule[] = [
  {
    id: 'production', title: 'Ishlab chiqarish', icon: Factory,
    description: 'Buyurtmadan tayyor mahsulotgacha bo‘lgan ish jarayoni.',
    groups: [
      {
        title: 'Buyurtmalar',
        pages: [
          { id: 'calculate', title: 'Buyurtma ochish', description: 'Mahsulot parametrlari, material qatlamlari va server hisoblash natijasi.', icon: Calculator },
          { id: 'orders', title: 'Buyurtmalar', description: 'Ochiq buyurtmalar, mijozlar va ishlab chiqarish holati.', icon: ClipboardList, resource: 'orders' },
          { id: 'pending', title: 'Kutilayotgan buyurtmalar', description: 'Ishlab chiqarishga ochilishi kutilayotgan buyurtmalar.', icon: ListOrdered, resource: 'pending' },
          { id: 'templates', title: 'Tezkor buyurtmalar', description: 'Saqlangan buyurtma hisoblari va qayta foydalaniladigan namunalar.', icon: ScrollText, resource: 'templates' },
          { id: 'completed', title: 'Tugallangan ishlar', description: 'Uskunalarda yakunlangan buyurtma bosqichlari va ularning natijalari.', icon: PackageCheck, resource: 'completed' },
          { id: 'closed', title: 'Yopilgan buyurtmalar', description: 'Yopilgan buyurtmalar va ularning yakuniy yozuvlari.', icon: Archive, resource: 'closed' },
        ],
      },
      {
        title: 'Ish jarayoni',
        pages: [
          { id: 'production-time', title: 'Ishlab chiqarish vaqti', description: 'Qayd etilgan bosqichlar, to‘xtashlar va apparat navbatlarini tekshirish.', icon: Clock3 },
          { id: 'factory-map', title: '3D zavod xaritasi', description: 'Zavoddagi apparatlar, joriy buyurtmalar va ish holati.', icon: Factory },
          { id: 'maps', title: 'Ish xaritalari', description: 'Buyurtma operatsiyalari, ishlab chiqarish bosqichlari va uskunalar.', icon: Waypoints, resource: 'maps' },
          { id: 'completion', title: 'Yakunlash so‘rovlari', description: 'Uskunalardan kelgan ishni yakunlash so‘rovlarini ko‘rib chiqish.', icon: ClipboardCheck, resource: 'completion' },
          { id: 'wip', title: 'Yarim tayyor mahsulotlar', description: 'Jarayondagi rulonlar, partiyalar va ularning joriy joylashuvi.', icon: Layers3, resource: 'wip' },
          { id: 'opening-wip', title: 'Boshlang‘ich WIP', description: 'Tizimga boshlang‘ich qoldiq sifatida kiritilgan ishlab chiqarish partiyalari.', icon: SquareStack, resource: 'opening-wip' },
        ],
      },
      {
        title: 'Uskunalar',
        pages: [
          { id: 'apparatus', title: 'Uskunalar', description: 'Bosma, laminatsiya, kesish va qadoqlash uskunalari.', icon: Wrench, resource: 'apparatus' },
        ],
      },
    ],
  },
  {
    id: 'warehouse', title: 'Ombor', icon: Warehouse,
    description: 'Omborlar, xomashyo va tayyor mahsulot qoldiqlari.',
    groups: [
      {
        title: 'Ombor hisobi',
        pages: [
          { id: 'warehouses', title: 'Omborlar', description: 'Ombor tuzilmasi, qoldiqlar va mas’ul foydalanuvchilar.', icon: Warehouse, resource: 'warehouses' },
          { id: 'stock', title: 'Mahsulot qoldiqlari', description: 'Omborlardagi mahsulotlar, miqdor va o‘ramlar.', icon: Boxes, resource: 'stock' },
          { id: 'raw-materials', title: 'Xomashyo qoldiqlari', description: 'Xomashyo rulonlari, o‘lchamlari va band qilingan buyurtmalar.', icon: Layers3, resource: 'raw-materials' },
          { id: 'locations', title: 'Zavod joylashuvlari', description: 'Sex, ombor va ishlab chiqarish joylashuvlari.', icon: MapPin, resource: 'locations' },
          { id: 'assets', title: 'Inventar joylashuvi', description: 'Xomashyo, tayyor mahsulot va qoliplarning joriy joylashuvi.', icon: Boxes, resource: 'assets' },
        ],
      },
    ],
  },
  {
    id: 'catalog', title: 'Ma’lumotnomalar', icon: Package,
    description: 'Mahsulotlar, materiallar va ishlab chiqarish hamkorlari.',
    groups: [
      {
        title: 'Mahsulotlar',
        pages: [
          { id: 'items', title: 'Mahsulotlar', description: 'Mahsulot kodi, o‘lchov birligi va guruhlar.', icon: Package, resource: 'items' },
          { id: 'item-groups', title: 'Mahsulot guruhlari', description: 'Mahsulotlarning ichma-ich guruh tuzilmasi.', icon: FolderTree, resource: 'item-groups' },
          { id: 'materials', title: 'Materiallar va mikronlar', description: 'Buyurtma hisobida ishlatiladigan materiallar va qalinliklar.', icon: SlidersHorizontal, resource: 'materials' },
        ],
      },
      {
        title: 'Hamkorlar',
        pages: [
          { id: 'customers', title: 'Mijozlar', description: 'Buyurtma beruvchi mijozlar va aloqa ma’lumotlari.', icon: Building2, resource: 'customers' },
          { id: 'suppliers', title: 'Ta’minotchilar', description: 'Xomashyo va mahsulot ta’minotchilari.', icon: Building2, resource: 'suppliers' },
        ],
      },
    ],
  },
  {
    id: 'management', title: 'Boshqaruv', icon: Settings2,
    description: 'Odamlar, ruxsatlar va tizim sozlamalari.',
    groups: [
      {
        title: 'Odamlar va huquqlar',
        pages: [
          { id: 'users', title: 'Foydalanuvchilar', description: 'Tizim foydalanuvchilari, rollari va kirish holati.', icon: Users, resource: 'users' },
          { id: 'workers', title: 'Xodimlar', description: 'Ishlab chiqarish xodimlari va uskunalarga biriktirish.', icon: Users, resource: 'workers' },
          { id: 'roles', title: 'Rollar va huquqlar', description: 'Rollar bo‘yicha mavjud imkoniyatlar va ruxsatlar.', icon: ShieldCheck, resource: 'roles' },
        ],
      },
      {
        title: 'Tizim',
        pages: [
          { id: 'activity', title: 'Faoliyat tarixi', description: 'Ta’minotchilar yuborgan va omborda qabul qilingan mahsulotlar tarixi.', icon: Activity, resource: 'activity' },
          { id: 'settings', title: 'Sozlamalar', description: 'ERP serveridan kelgan sozlamalar va ulanish ma’lumotlari.', icon: Settings2 },
          { id: 'server', title: 'Server holati', description: 'Ulangan ERP serverining joriy ishlash ko‘rsatkichlari.', icon: Activity },
        ],
      },
    ],
  },
]

export const allPages: NavigationPage[] = [
  homePage,
  ...modules.flatMap((module) => [
    { id: module.id, title: module.title, description: module.description, icon: module.icon },
    ...module.groups.flatMap((group) => group.pages),
  ]),
]

export function pageById(id: string): NavigationPage | undefined {
  if (id === 'map-editor') return { id, title: 'Production map', description: 'Buyurtmaning ishlab chiqarish xaritasini tuzish.', icon: Waypoints }
  return allPages.find((page) => page.id === id)
}

export function moduleForPage(id: string): NavigationModule | undefined {
  if (id === 'map-editor') return modules.find(module => module.id === 'production')
  return modules.find((module) => module.id === id || module.groups.some((group) => group.pages.some((page) => page.id === id)))
}
