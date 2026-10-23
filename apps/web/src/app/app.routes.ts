import { Routes } from '@angular/router';
import {
  adminHomeGuard,
  authGuard,
  companyGuard,
  entryGuard,
  homeGuard,
  permissionGuard,
} from './core/guards';
import { ShellComponent } from './layout/shell';
import { EmptyPage } from './pages/empty';
import { ForbiddenPage } from './pages/forbidden';
import { LoginPage } from './pages/login';
import { NotFoundPage } from './pages/not-found';
import { UnavailablePage } from './pages/unavailable';

export const routes: Routes = [
  { path: 'login', component: LoginPage },
  { path: '', pathMatch: 'full', canActivate: [entryGuard], component: EmptyPage },
  {
    path: 'c/:companyId',
    component: ShellComponent,
    canActivate: [authGuard, companyGuard],
    children: [
      { path: '', pathMatch: 'full', canActivate: [homeGuard], component: EmptyPage },
      {
        path: 'orders',
        loadComponent: () => import('./orders/order-list').then((module) => module.OrderListPage),
        canActivate: [permissionGuard],
        data: { permission: 'order.view' },
      },
      {
        path: 'orders/:orderId',
        loadComponent: () =>
          import('./orders/order-detail').then((module) => module.OrderDetailPage),
        canActivate: [permissionGuard],
        data: { permission: 'order.view' },
      },
      {
        path: 'clients',
        loadComponent: () =>
          import('./clients/client-list').then((module) => module.ClientListPage),
        canActivate: [permissionGuard],
        data: { permission: 'client.view' },
      },
      {
        path: 'clients/new',
        loadComponent: () =>
          import('./clients/client-form').then((module) => module.ClientFormPage),
        canActivate: [permissionGuard],
        data: { permission: 'client.view' },
      },
      {
        path: 'clients/:clientId',
        loadComponent: () =>
          import('./clients/client-form').then((module) => module.ClientFormPage),
        canActivate: [permissionGuard],
        data: { permission: 'client.view' },
      },
      {
        path: 'invoices',
        loadComponent: () =>
          import('./invoices/invoice-list').then((module) => module.InvoiceListPage),
        canActivate: [permissionGuard],
        data: { permission: 'invoice.view' },
      },
      {
        path: 'invoices/new',
        loadComponent: () =>
          import('./invoices/invoice-editor').then((module) => module.InvoiceEditorPage),
        canActivate: [permissionGuard],
        data: { permission: 'invoice.view' },
      },
      {
        path: 'invoices/:invoiceId',
        loadComponent: () =>
          import('./invoices/invoice-editor').then((module) => module.InvoiceEditorPage),
        canActivate: [permissionGuard],
        data: { permission: 'invoice.view' },
      },
      { path: 'admin', pathMatch: 'full', canActivate: [adminHomeGuard], component: EmptyPage },
      {
        path: 'admin/members',
        loadComponent: () => import('./admin/members-page').then((module) => module.MembersPage),
        canActivate: [permissionGuard],
        data: { permission: 'member.view' },
      },
      {
        path: 'admin/automation',
        loadComponent: () =>
          import('./admin/automation-page').then((module) => module.AutomationPage),
        canActivate: [permissionGuard],
        data: { permission: 'automation.view' },
      },
      {
        path: 'admin/audit',
        loadComponent: () => import('./admin/audit-page').then((module) => module.AuditPage),
        canActivate: [permissionGuard],
        data: { permission: 'audit.view' },
      },
      {
        path: 'admin/printers',
        loadComponent: () => import('./admin/printers-page').then((module) => module.PrintersPage),
        canActivate: [permissionGuard],
        data: { permission: 'printer.manage' },
      },
      {
        path: 'admin/company',
        loadComponent: () => import('./admin/company-page').then((module) => module.CompanyPage),
        canActivate: [permissionGuard],
        data: { permission: 'company.view' },
      },
      {
        path: 'admin/stores',
        loadComponent: () => import('./admin/stores-page').then((module) => module.StoresPage),
        canActivate: [permissionGuard],
        data: { permission: 'store.view' },
      },
    ],
  },
  { path: 'forbidden', component: ForbiddenPage },
  { path: 'not-found', component: NotFoundPage },
  { path: 'unavailable', component: UnavailablePage },
  { path: '**', component: NotFoundPage },
];
