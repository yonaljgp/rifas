import { Resend } from 'resend';
import TicketEmail from '../template/template'; // Asegúrate que la ruta a tu plantilla sea correcta
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/app/api/supabase/server'; // Asegúrate que la ruta a tu cliente de Supabase sea correcta

export const dynamic = 'force-dynamic';


const resend = new Resend(process.env.RESEND_API_KEY);

// --- Definiciones de Tipos para la respuesta de Supabase ---

interface UserData {
  id_user: number;
  name: string;
  email: string;
  id_card: string;
}

interface PayData {
  id_pay: number; // Añadido para agrupar por transacción
  validated: boolean;
  // CORRECCIÓN: La relación, aunque sea a uno, puede ser devuelta como un array por Supabase.
  // Lo ajustamos para que espere un array de UserData.
  user_data: UserData[] | null;
}

interface TicketData {
  id_tickets: number;
  tickets: string;
  email_send: boolean;
  pay_data: PayData | PayData[] | null;
}

// --- Fin de Definiciones de Tipos ---

// Handler para peticiones GET (usado por Vercel Cron Jobs)
export async function GET(request: NextRequest) {
  return POST(request);
}

export async function POST(request: NextRequest) {
  
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const supabase = await createClient();

    // 2. --- Obtener boletos con pago validado que no han sido enviados ---
    // Se inicia la consulta desde 'tickets' para asegurar que el boleto específico
    // esté asociado a un pago validado a través de su 'pay_id'.
    const { data: ticketsData, error: fetchError } = await supabase // ticketsData es de tipo TicketData[]
      .from('tickets')
      .select(`
        id_tickets,
        tickets,
        email_send,
        pay_data!inner (
          id_pay,
          validated,
          user_data ( id_user, name, email, id_card )
        )
      `)
      .eq('email_send', false)
      .eq('pay_data.validated', true);

    if (fetchError) {
      console.error('Error al obtener usuarios de Supabase:', fetchError);
      return NextResponse.json(
        { message: 'Error al obtener usuarios para enviar correos', error: fetchError.message },
        { status: 500 },
      );
    }
    if (!ticketsData || ticketsData.length === 0) { // ticketsData es de tipo TicketData[]
      return NextResponse.json({ message: 'No hay correos pendientes por enviar.' });

    }

    const results = {
      success: [] as { id_user: number; email_id: string }[],
      failed: [] as { id_user: number; error: string }[],
    };

    // 3. --- Agrupar boletos por USUARIO Y MONEDA ---
    // Se agrupan los boletos por una clave compuesta (usuario + moneda) para enviar
    // correos separados.
    const usersToEmail: { [key: string]: { id_user: number; name: string; email: string; id_card: string; tickets: TicketData[]; } } = {};

    for (const ticket of ticketsData as TicketData[]) {
      const payData = Array.isArray(ticket.pay_data) ? ticket.pay_data[0] : ticket.pay_data;
      const userArray = payData?.user_data;
      const user = Array.isArray(userArray) ? userArray[0] : userArray;

      if (!user) continue;
 
      const groupKey = String(user.id_user);

      if (!usersToEmail[groupKey]) {
        usersToEmail[groupKey] = {
          id_user: user.id_user,
          name: user.name,
          email: user.email,
          id_card: user.id_card,
          tickets: [],
        };
      }
      usersToEmail[groupKey].tickets.push(ticket);
    }

    // 4. --- Preparar y enviar todos los correos en paralelo ---
    const emailPromises = Object.values(usersToEmail).map(async (user) => {
      if (!user.email) {
        return {
          status: 'rejected',
          reason: { id_user: user.id_user, error: 'El usuario no tiene un email registrado.' }
        };
      }

      const tickets = user.tickets.map((t) => String(t.tickets).padStart(4, '0'));
      const nameToLowerCase = user.name.charAt(0).toUpperCase() + user.name.slice(1);

      // Envía el correo usando Resend y la plantilla de React
      const { data: sentEmail, error: sendError } = await resend.emails.send({
        from: 'JuegacnNosotros <noreply@juegacnnosotros.com>', 
        to: user.email,
        subject: `Tu Compra ha sido Aprobada ${nameToLowerCase} `,
        react: TicketEmail({
          name: nameToLowerCase || 'Participante',
          tickets: tickets.join(', '),
          ticketCount: tickets.length,
          cardId: user.id_card,
        }),
      });

      if (sendError) {
        // Si el envío falla, lanzamos un error para que Promise.allSettled lo capture como 'rejected'.
        throw { id_user: user.id_user, error: sendError.message || JSON.stringify(sendError) };
      }

      // 5. --- Actualizar la base de datos si el envío fue exitoso ---
      const ticketIdsToUpdate = user.tickets.map((t) => t.id_tickets);
      const { error: updateError } = await supabase
        .from('tickets')
        .update({ email_send: true })
        .in('id_tickets', ticketIdsToUpdate);

      if (updateError) {
        // Si la actualización falla, también lo consideramos un fallo parcial.
        console.error(`Correo enviado a ${user.email}, pero falló la actualización en Supabase:`, updateError);
        throw { id_user: user.id_user, error: `Email sent, but DB update failed: ${updateError.message}` };
      }

      return { status: 'fulfilled', value: { id_user: user.id_user, email_id: sentEmail.id } };
    });

    // Ejecutamos todas las promesas de envío en paralelo
    const settledResults = await Promise.allSettled(emailPromises);

    // 6. --- Procesar los resultados ---
    settledResults.forEach(result => {
      // Caso 1: La promesa se cumplió (envío exitoso o fallo manejado como la falta de email)
      if (result.status === 'fulfilled') {
        const res = result.value;
        // Verificamos el estado interno que definimos
        if (res.status === 'fulfilled' && res.value) {
          results.success.push(res.value);
        } else if (res.status === 'rejected' && res.reason) {
          results.failed.push(res.reason);
        }
      } else {
        // Caso 2: La promesa fue rechazada (hubo un `throw` por error de envío o de BD)
        console.error(`Fallo en el proceso para un usuario:`, result.reason);
        results.failed.push(result.reason);
      }
    });

    return NextResponse.json({ message: 'Proceso de envío de correos completado.', results });
  } catch (e: any) {
    console.error('Error inesperado en el endpoint POST:', e);
    return NextResponse.json({ message: 'Ocurrió un error inesperado en el servidor.', error: e.message }, { status: 500 });
  }
}